import type {
	AgentToolUpdateCallback,
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { Type, type Static } from "typebox";
import registerLocalAskUserQuestionExtension from "@juicesharp/rpiv-ask-user-question";
import {
	formatQuestionMessage,
	TelegramApiError,
	TelegramClient,
	type TelegramAnswer,
	type TelegramConfig,
	type TelegramQuestion,
} from "./telegram.js";

const TOOL_NAME = "ask_user_question";
const CONFIG_PATH =
	process.env.PI_TELEGRAM_ASK_CONFIG ??
	join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "pi-telegram-ask", "config.json");
const KEYCHAIN_SERVICE = "pi-agent-telegram";
const MAX_QUESTIONS = 4;
const MAX_OPTIONS = 4;
const MAX_HEADER_LENGTH = 16;
const MAX_LABEL_LENGTH = 60;
const RESERVED_LABELS = new Set(["Other", "Type something.", "Next question"]);

const OptionSchema = Type.Object({
	label: Type.String({
		maxLength: MAX_LABEL_LENGTH,
		description: "Concise proposed answer shown to the developer (maximum 60 characters).",
	}),
	description: Type.String({
		description: "Explain what this answer means or its important trade-offs.",
	}),
	preview: Type.Optional(
		Type.String({
			description: "Optional artifact associated with this answer. It is not sent to Telegram.",
		}),
	),
});

const QuestionSchema = Type.Object({
	question: Type.String({
		description: "Clear, self-contained question for the developer.",
	}),
	header: Type.String({
		maxLength: MAX_HEADER_LENGTH,
		description: "Short topic label, maximum 16 characters.",
	}),
	options: Type.Optional(
		Type.Array(OptionSchema, {
			maxItems: MAX_OPTIONS,
			description: "Optional proposed answers. Omit when a free-form answer is more appropriate.",
		}),
	),
	multiSelect: Type.Optional(
		Type.Boolean({
			default: false,
			description: "Allow several proposed answers. Requires at least two options.",
		}),
	),
});

const ParamsSchema = Type.Object({
	questions: Type.Array(QuestionSchema, {
		minItems: 1,
		maxItems: MAX_QUESTIONS,
		description: "One to four questions. They are sent and answered sequentially in Telegram.",
	}),
});

type Params = Static<typeof ParamsSchema>;

type QuestionMode = "telegram" | "local";

type StoredConfig = {
	mode?: QuestionMode;
	chatId?: string | number;
	userId?: string | number;
	threadId?: string | number;
	pollTimeoutSeconds?: number;
	keychainService?: string;
	keychainAccount?: string;
};

type LocalTool = Pick<ToolDefinition, "execute">;

type QuestionAnswer = TelegramAnswer & {
	questionIndex: number;
	question: string;
};

type ToolDetails = {
	answers: QuestionAnswer[];
	cancelled: boolean;
	error?: string;
};

type ConfigResult =
	| { ok: true; config: TelegramConfig; tokenSource: "environment" | "keychain" }
	| { ok: false; error: string };

function toolResult(text: string, details: ToolDetails) {
	return { content: [{ type: "text" as const, text }], details };
}

function readStoredConfig(): StoredConfig {
	try {
		const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as StoredConfig) : {};
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return {};
		throw new Error(`Cannot read Telegram question config at ${CONFIG_PATH}`);
	}
}

function writeStoredConfig(config: StoredConfig): void {
	const directory = dirname(CONFIG_PATH);
	const temporaryPath = `${CONFIG_PATH}.tmp-${process.pid}`;
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	chmodSync(directory, 0o700);
	writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	renameSync(temporaryPath, CONFIG_PATH);
	chmodSync(CONFIG_PATH, 0o600);
}

function configuredMode(): QuestionMode {
	return readStoredConfig().mode === "telegram" ? "telegram" : "local";
}

function captureLocalTool(pi: ExtensionAPI): LocalTool {
	let captured: LocalTool | undefined;
	const proxy = new Proxy(pi, {
		get(target, property, receiver) {
			if (property === "registerTool") {
				return (tool: ToolDefinition) => {
					if (tool.name === TOOL_NAME) captured = tool;
				};
			}
			// The wrapped package hides its tool when no terminal UI exists. This
			// package must keep the wrapper active because Telegram also works in
			// headless Pi modes, so its lifecycle reconciler is intentionally omitted.
			if (property === "on") return () => undefined;
			return Reflect.get(target, property, receiver);
		},
	});
	registerLocalAskUserQuestionExtension(proxy as ExtensionAPI);
	if (!captured) throw new Error("Could not load the local ask_user_question implementation");
	return captured;
}

function integerId(value: unknown, name: string, allowNegative: boolean): number {
	const text = String(value ?? "").trim();
	const pattern = allowNegative ? /^-?\d+$/ : /^\d+$/;
	if (!pattern.test(text)) throw new Error(`${name} must be an integer`);
	const parsed = Number(text);
	if (!Number.isSafeInteger(parsed)) throw new Error(`${name} is outside JavaScript's safe integer range`);
	return parsed;
}

function boundedPollTimeout(value: unknown): number {
	if (value === undefined) return 45;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 5 || parsed > 50) {
		throw new Error("pollTimeoutSeconds must be an integer between 5 and 50");
	}
	return parsed;
}

async function resolveToken(
	pi: ExtensionAPI,
	stored: StoredConfig,
	signal?: AbortSignal,
): Promise<{ token: string; source: "environment" | "keychain" } | undefined> {
	const environmentToken = process.env.PI_TELEGRAM_BOT_TOKEN?.trim();
	if (environmentToken) return { token: environmentToken, source: "environment" };
	if (process.platform !== "darwin") return undefined;

	const service = stored.keychainService?.trim() || KEYCHAIN_SERVICE;
	const account = stored.keychainAccount?.trim() || process.env.USER || "";
	if (!account) return undefined;
	const result = await pi.exec(
		"/usr/bin/security",
		["find-generic-password", "-s", service, "-a", account, "-w"],
		{ signal, timeout: 10_000 },
	);
	const token = result.code === 0 ? result.stdout.trim() : "";
	return token ? { token, source: "keychain" } : undefined;
}

async function loadConfig(pi: ExtensionAPI, signal?: AbortSignal): Promise<ConfigResult> {
	try {
		const stored = readStoredConfig();
		const token = await resolveToken(pi, stored, signal);
		if (!token) {
			return {
				ok: false,
				error: `Telegram bot token is missing. Set PI_TELEGRAM_BOT_TOKEN or store it in macOS Keychain service "${stored.keychainService ?? KEYCHAIN_SERVICE}".`,
			};
		}
		const chatId = integerId(process.env.PI_TELEGRAM_CHAT_ID ?? stored.chatId, "chatId", true);
		const userId = integerId(process.env.PI_TELEGRAM_USER_ID ?? stored.userId, "userId", false);
		const rawThreadId = process.env.PI_TELEGRAM_THREAD_ID ?? stored.threadId;
		const threadId = rawThreadId === undefined ? undefined : integerId(rawThreadId, "threadId", false);
		return {
			ok: true,
			tokenSource: token.source,
			config: {
				token: token.token,
				chatId,
				userId,
				threadId,
				pollTimeoutSeconds: boundedPollTimeout(stored.pollTimeoutSeconds),
			},
		};
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

function validate(params: Params): string | undefined {
	if (params.questions.length === 0 || params.questions.length > MAX_QUESTIONS) {
		return `ask_user_question requires 1-${MAX_QUESTIONS} questions`;
	}
	const seenQuestions = new Set<string>();
	for (const question of params.questions) {
		if (seenQuestions.has(question.question)) return "Question text must be unique within one invocation";
		seenQuestions.add(question.question);
		const options = question.options ?? [];
		if (question.multiSelect && options.length < 2) return "A multi-select question requires at least two options";
		const labels = new Set<string>();
		for (const option of options) {
			if (RESERVED_LABELS.has(option.label)) return `Option label is reserved: ${option.label}`;
			if (labels.has(option.label)) return `Duplicate option label: ${option.label}`;
			labels.add(option.label);
		}
	}
	return undefined;
}

function answerText(answer: QuestionAnswer): string {
	if (answer.kind === "multi") return answer.selected?.join(", ") ?? "";
	return answer.answer ?? "";
}

function responseEnvelope(answers: QuestionAnswer[], channel: "Telegram" | "Pi"): string {
	const segments = answers.map((answer) => {
		const parts = [`${JSON.stringify(answer.question)}=${JSON.stringify(answerText(answer))}`];
		if (answer.preview) parts.push(`selected preview: ${answer.preview}`);
		return `${parts.join(". ")}.`;
	});
	return `The developer answered via ${channel}: ${segments.join(" ")} Continue the workflow using these answers.`;
}

type LocalQuestionnaireDetails = {
	answers?: Array<TelegramAnswer & { questionIndex: number; question: string }>;
	cancelled?: boolean;
};

function localDetails(value: unknown): LocalQuestionnaireDetails | undefined {
	return value && typeof value === "object" ? (value as LocalQuestionnaireDetails) : undefined;
}

async function runLocalQuestionnaire(
	localTool: LocalTool,
	toolCallId: string,
	params: Params,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<unknown> | undefined,
	ctx: ExtensionContext,
) {
	const allQuestionsUseOriginalUi = params.questions.every((question) => (question.options?.length ?? 0) >= 2);
	if (allQuestionsUseOriginalUi) {
		return localTool.execute(toolCallId, params, signal, onUpdate, ctx);
	}

	const answers: QuestionAnswer[] = [];
	for (let index = 0; index < params.questions.length; index += 1) {
		const question = params.questions[index] as TelegramQuestion;
		const options = question.options ?? [];
		if (options.length >= 2) {
			const result = await localTool.execute(toolCallId, { questions: [question] }, signal, onUpdate, ctx);
			const details = localDetails(result.details);
			if (details?.cancelled || !details?.answers?.[0]) {
				return toolResult("The developer cancelled the local questionnaire.", { answers, cancelled: true });
			}
			answers.push({ ...details.answers[0], questionIndex: index, question: question.question });
			continue;
		}

		let answer: TelegramAnswer | undefined;
		if (options.length === 1) {
			const customChoice = "Type something.";
			const choice = await ctx.ui.select(`${question.header}: ${question.question}`, [options[0].label, customChoice]);
			if (choice === undefined) return toolResult("The developer cancelled the local questionnaire.", { answers, cancelled: true });
			if (choice === options[0].label) {
				answer = { kind: "option", answer: options[0].label, preview: options[0].preview };
			}
		}
		if (!answer) {
			const text = await ctx.ui.input(`${question.header}: ${question.question}`, "Type your answer");
			if (text === undefined) return toolResult("The developer cancelled the local questionnaire.", { answers, cancelled: true });
			answer = { kind: "custom", answer: text.trim() };
		}
		answers.push({ ...answer, questionIndex: index, question: question.question });
	}
	return toolResult(responseEnvelope(answers, "Pi"), { answers, cancelled: false });
}

export default function telegramAsk(pi: ExtensionAPI) {
	const localTool = captureLocalTool(pi);
	pi.registerTool({
		name: TOOL_NAME,
		label: "Ask Developer",
		description: `Pause the current workflow and ask the developer one or more questions through the configured channel: Telegram or Pi's local questionnaire. Proposed answers are optional; the developer can always reply with free text. The tool waits until the developer answers, cancels, or aborts the current Pi turn.`,
		promptSnippet: "Pause and ask the developer questions through the configured local or Telegram channel",
		promptGuidelines: [
			"Use ask_user_question when a missing developer decision blocks safe progress; do not guess.",
			"Keep Telegram questions self-contained and concise because project code and conversation context are not forwarded.",
			"Add proposed answers only when they clarify meaningful alternatives, and put the recommended answer first with '(Recommended)' in its label.",
			"Group related decisions into one ask_user_question call, with at most four questions.",
		],
		parameters: ParamsSchema,
		executionMode: "sequential",

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const typed = params as Params;
			const validationError = validate(typed);
			if (validationError) return toolResult(`Error: ${validationError}`, { answers: [], cancelled: true, error: validationError });

			if (configuredMode() === "local") {
				pi.events.emit("herdr:blocked", { active: true, label: "Waiting for local answer" });
				try {
					return await runLocalQuestionnaire(localTool, _toolCallId, typed, signal, _onUpdate, ctx);
				} finally {
					pi.events.emit("herdr:blocked", { active: false });
				}
			}

			const resolved = await loadConfig(pi, signal);
			if (!resolved.ok) {
				if (ctx.hasUI) ctx.ui.notify(resolved.error, "error");
				return toolResult(`Error: ${resolved.error}`, { answers: [], cancelled: true, error: "configuration" });
			}

			const client = new TelegramClient(resolved.config);
			const projectName = basename(ctx.cwd) || ctx.cwd;
			const answers: QuestionAnswer[] = [];
			ctx.ui.setStatus("telegram-ask", "Waiting for Telegram");
			pi.events.emit("herdr:blocked", { active: true, label: "Waiting for Telegram" });
			pi.events.emit("rpiv:ask-user:blocked", { active: true });

			try {
				await client.initializeOffset(signal);
				for (let index = 0; index < typed.questions.length; index += 1) {
					const question = typed.questions[index] as TelegramQuestion;
					pi.events.emit("rpiv:ask-user:prompt", {
						questions: [
							{
								question: question.question,
								header: question.header,
								multiSelect: question.multiSelect ?? false,
								options: (question.options ?? []).map((option) => ({
									label: option.label,
									description: option.description,
									hasPreview: typeof option.preview === "string" && option.preview.length > 0,
								})),
							},
						],
					});
					const nonce = randomBytes(6).toString("hex");
					const text = formatQuestionMessage(question, index, typed.questions.length, projectName);
					const sent = await client.sendQuestion(text, question, nonce, signal);
					const answer = await client.waitForAnswer(sent, question, nonce, signal);
					if (!answer) {
						return toolResult("The developer cancelled the Telegram questionnaire.", { answers, cancelled: true });
					}
					answers.push({ ...answer, questionIndex: index, question: question.question });
				}
				return toolResult(responseEnvelope(answers, "Telegram"), { answers, cancelled: false });
			} catch (error) {
				if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
					return toolResult("The Telegram questionnaire was aborted from Pi.", { answers, cancelled: true });
				}
				const message =
					error instanceof TelegramApiError
						? error.message
						: `Telegram question failed: ${error instanceof Error ? error.message : String(error)}`;
				if (ctx.hasUI) ctx.ui.notify(message, "error");
				return toolResult(`Error: ${message}`, { answers, cancelled: true, error: "telegram" });
			} finally {
				ctx.ui.setStatus("telegram-ask", undefined);
				pi.events.emit("rpiv:ask-user:blocked", { active: false });
				pi.events.emit("herdr:blocked", { active: false });
			}
		},
	});

	async function showStatus(ctx: ExtensionContext): Promise<void> {
		const mode = configuredMode();
		if (mode === "local") {
			ctx.ui.notify("Developer questions use Pi's local questionnaire", "info");
			return;
		}
		const resolved = await loadConfig(pi, ctx.signal);
		if (!resolved.ok) {
			ctx.ui.notify(`Telegram mode is enabled but unavailable: ${resolved.error}`, "error");
			return;
		}
		const thread = resolved.config.threadId === undefined ? "none" : String(resolved.config.threadId);
		ctx.ui.notify(`Developer questions use Telegram (token: ${resolved.tokenSource}, thread: ${thread})`, "info");
	}

	pi.registerCommand("telegram-ask", {
		description: "Toggle Telegram developer questions (on|off|status)",
		handler: async (args, ctx) => {
			const requested = args.trim().toLowerCase();
			if (!requested || requested === "status") {
				await showStatus(ctx);
				return;
			}
			const mode: QuestionMode | undefined =
				requested === "telegram" || requested === "on"
					? "telegram"
					: requested === "local" || requested === "off"
						? "local"
						: undefined;
			if (!mode) {
				ctx.ui.notify("Usage: /telegram-ask on|off|status", "warning");
				return;
			}
			writeStoredConfig({ ...readStoredConfig(), mode });
			ctx.ui.notify(
				mode === "telegram"
					? "Developer questions will now use Telegram"
					: "Telegram disabled; developer questions will now use Pi locally",
				"info",
			);
		},
	});

	pi.registerCommand("telegram-ask-status", {
		description: "Show the active developer-question channel without revealing credentials",
		handler: async (_args, ctx) => showStatus(ctx),
	});
}
