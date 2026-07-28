export interface TelegramOption {
	label: string;
	description: string;
	preview?: string;
}

export interface TelegramQuestion {
	question: string;
	header: string;
	options?: TelegramOption[];
	multiSelect?: boolean;
}

export interface TelegramConfig {
	token: string;
	chatId: number;
	userId: number;
	threadId?: number;
	pollTimeoutSeconds: number;
}

export interface TelegramAnswer {
	kind: "option" | "custom" | "multi";
	answer: string | null;
	selected?: string[];
	preview?: string;
}

interface TelegramUser {
	id: number;
}

interface TelegramChat {
	id: number;
	type?: string;
}

interface TelegramMessage {
	message_id: number;
	message_thread_id?: number;
	text?: string;
	from?: TelegramUser;
	chat: TelegramChat;
	reply_to_message?: { message_id: number };
}

interface TelegramCallbackQuery {
	id: string;
	from: TelegramUser;
	data?: string;
	message?: TelegramMessage;
}

interface TelegramUpdate {
	update_id: number;
	message?: TelegramMessage;
	callback_query?: TelegramCallbackQuery;
}

interface TelegramApiResponse<T> {
	ok: boolean;
	result?: T;
	description?: string;
	error_code?: number;
	parameters?: { retry_after?: number };
}

interface InlineButton {
	text: string;
	callback_data: string;
}

interface InlineKeyboard {
	inline_keyboard: InlineButton[][];
}

interface SentQuestion {
	messageId: number;
	text: string;
}

export class TelegramApiError extends Error {
	readonly status: number;
	readonly retryAfterSeconds?: number;

	constructor(method: string, status: number, description: string, retryAfterSeconds?: number) {
		super(`Telegram ${method} failed (${status}): ${description}`);
		this.name = "TelegramApiError";
		this.status = status;
		this.retryAfterSeconds = retryAfterSeconds;
	}
}

const API_ROOT = "https://api.telegram.org";
const MAX_MESSAGE_LENGTH = 4096;
const MAX_QUESTION_TEXT_LENGTH = 3500;

function abortError(): Error {
	const error = new Error("Telegram question aborted");
	error.name = "AbortError";
	return error;
}

export function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw abortError();
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	throwIfAborted(signal);
	return new Promise((resolve, reject) => {
		const finish = () => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		};
		const timer = setTimeout(finish, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(abortError());
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		timer.unref?.();
	});
}

function requestSignal(parent: AbortSignal | undefined, timeoutMs: number): AbortSignal {
	const timeout = AbortSignal.timeout(timeoutMs);
	return parent ? AbortSignal.any([parent, timeout]) : timeout;
}

function truncate(text: string, maxLength: number): string {
	if (text.length <= maxLength) return text;
	return `${text.slice(0, Math.max(0, maxLength - 16))}\n… [tronqué]`;
}

export function formatQuestionMessage(
	question: TelegramQuestion,
	questionIndex: number,
	questionCount: number,
	projectName: string,
): string {
	const lines = [
		"🤖 Pi attend votre réponse",
		`Projet : ${projectName}`,
		`Question ${questionIndex + 1}/${questionCount} · ${question.header}`,
		"",
		question.question,
	];

	const options = question.options ?? [];
	if (options.length > 0) {
		lines.push("", "Propositions :");
		for (let index = 0; index < options.length; index += 1) {
			const option = options[index];
			lines.push(`${index + 1}. ${option.label} — ${option.description}`);
		}
	}

	lines.push(
		"",
		question.multiSelect
			? "Sélectionnez une ou plusieurs propositions puis validez, ou répondez directement à ce message."
			: "Choisissez une proposition, ou répondez directement à ce message.",
	);
	return truncate(lines.join("\n"), MAX_QUESTION_TEXT_LENGTH);
}

export function parseCallbackData(
	data: string | undefined,
	nonce: string,
): { action: "option"; optionIndex: number } | { action: "done" | "cancel" } | undefined {
	if (!data) return undefined;
	const [prefix, receivedNonce, action, rawIndex] = data.split(":");
	if (prefix !== "piq" || receivedNonce !== nonce) return undefined;
	if (action === "done" || action === "cancel") return { action };
	if (action !== "option" || !/^\d+$/.test(rawIndex ?? "")) return undefined;
	return { action: "option", optionIndex: Number(rawIndex) };
}

export function buildKeyboard(question: TelegramQuestion, nonce: string, selected: ReadonlySet<number>): InlineKeyboard {
	const options = question.options ?? [];
	const rows: InlineButton[][] = options.map((option, index) => [
		{
			text: `${selected.has(index) ? "☑" : "☐"} ${option.label}`,
			callback_data: `piq:${nonce}:option:${index}`,
		},
	]);

	if (question.multiSelect && options.length > 0) {
		rows.push([
			{ text: "✅ Valider", callback_data: `piq:${nonce}:done` },
			{ text: "✖ Annuler", callback_data: `piq:${nonce}:cancel` },
		]);
	} else {
		rows.push([{ text: "✖ Annuler", callback_data: `piq:${nonce}:cancel` }]);
	}
	return { inline_keyboard: rows };
}

export class TelegramClient {
	private offset = 0;
	private readonly config: TelegramConfig;

	constructor(config: TelegramConfig) {
		this.config = config;
	}

	private async request<T>(method: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
		throwIfAborted(signal);
		const response = await fetch(`${API_ROOT}/bot${this.config.token}/${method}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(payload),
			signal: requestSignal(signal, (this.config.pollTimeoutSeconds + 10) * 1000),
		});
		const body = (await response.json()) as TelegramApiResponse<T>;
		if (!response.ok || !body.ok || body.result === undefined) {
			throw new TelegramApiError(
				method,
				body.error_code ?? response.status,
				body.description ?? "unknown API error",
				body.parameters?.retry_after,
			);
		}
		return body.result;
	}

	async initializeOffset(signal?: AbortSignal): Promise<void> {
		const updates = await this.request<TelegramUpdate[]>("getUpdates", { offset: -1, limit: 1, timeout: 0 }, signal);
		const latest = updates.at(-1);
		this.offset = latest ? latest.update_id + 1 : 0;
	}

	async sendQuestion(text: string, question: TelegramQuestion, nonce: string, signal?: AbortSignal): Promise<SentQuestion> {
		const payload: Record<string, unknown> = {
			chat_id: this.config.chatId,
			text,
			reply_markup: buildKeyboard(question, nonce, new Set()),
		};
		if (this.config.threadId !== undefined) payload.message_thread_id = this.config.threadId;
		const message = await this.request<TelegramMessage>("sendMessage", payload, signal);
		return { messageId: message.message_id, text };
	}

	private async getUpdates(signal?: AbortSignal): Promise<TelegramUpdate[]> {
		const updates = await this.request<TelegramUpdate[]>(
			"getUpdates",
			{
				offset: this.offset,
				timeout: this.config.pollTimeoutSeconds,
				allowed_updates: ["message", "callback_query"],
			},
			signal,
		);
		if (updates.length > 0) this.offset = updates[updates.length - 1].update_id + 1;
		return updates;
	}

	private async answerCallback(id: string, text?: string, showAlert = false): Promise<void> {
		await this.request("answerCallbackQuery", {
			callback_query_id: id,
			...(text ? { text, show_alert: showAlert } : {}),
		});
	}

	private async updateKeyboard(sent: SentQuestion, keyboard: InlineKeyboard, signal?: AbortSignal): Promise<void> {
		await this.request(
			"editMessageReplyMarkup",
			{ chat_id: this.config.chatId, message_id: sent.messageId, reply_markup: keyboard },
			signal,
		);
	}

	private async finalize(sent: SentQuestion, summary: string, signal?: AbortSignal): Promise<void> {
		const text = truncate(`${sent.text}\n\n${summary}`, MAX_MESSAGE_LENGTH);
		await this.request(
			"editMessageText",
			{ chat_id: this.config.chatId, message_id: sent.messageId, text, reply_markup: { inline_keyboard: [] } },
			signal,
		);
	}

	private matchesMessage(message: TelegramMessage, sent: SentQuestion): boolean {
		if (message.chat.id !== this.config.chatId || message.from?.id !== this.config.userId) return false;
		if (this.config.threadId !== undefined && message.message_thread_id !== this.config.threadId) return false;
		const repliesToQuestion = message.reply_to_message?.message_id === sent.messageId;
		const isPrivateDeveloperChat = this.config.chatId === this.config.userId && message.chat.type === "private";
		return repliesToQuestion || isPrivateDeveloperChat;
	}

	async waitForAnswer(
		sent: SentQuestion,
		question: TelegramQuestion,
		nonce: string,
		signal?: AbortSignal,
	): Promise<TelegramAnswer | null> {
		const options = question.options ?? [];
		const selected = new Set<number>();

		while (true) {
			throwIfAborted(signal);
			let updates: TelegramUpdate[];
			try {
				updates = await this.getUpdates(signal);
			} catch (error) {
				if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
				if (error instanceof TelegramApiError && error.retryAfterSeconds !== undefined) {
					await sleep(error.retryAfterSeconds * 1000, signal);
					continue;
				}
				if (error instanceof TypeError || (error instanceof Error && error.name === "TimeoutError")) {
					await sleep(2000, signal);
					continue;
				}
				throw error;
			}

			for (const update of updates) {
				const callback = update.callback_query;
				if (callback?.message?.message_id === sent.messageId) {
					if (callback.from.id !== this.config.userId || callback.message.chat.id !== this.config.chatId) {
						await this.answerCallback(callback.id, "Réponse non autorisée", true);
						continue;
					}
					const parsed = parseCallbackData(callback.data, nonce);
					if (!parsed) continue;
					if (parsed.action === "cancel") {
						await this.answerCallback(callback.id);
						await this.finalize(sent, "✖ Question annulée", signal);
						return null;
					}
					if (parsed.action === "option") {
						const option = options[parsed.optionIndex];
						if (!option) continue;
						if (!question.multiSelect) {
							await this.answerCallback(callback.id);
							await this.finalize(sent, `✅ Réponse : ${option.label}`, signal);
							return { kind: "option", answer: option.label, preview: option.preview };
						}
						selected.has(parsed.optionIndex) ? selected.delete(parsed.optionIndex) : selected.add(parsed.optionIndex);
						await this.answerCallback(callback.id);
						await this.updateKeyboard(sent, buildKeyboard(question, nonce, selected), signal);
						continue;
					}
					if (selected.size === 0) {
						await this.answerCallback(callback.id, "Choisissez au moins une proposition", true);
						continue;
					}
					const labels = [...selected].sort((a, b) => a - b).map((index) => options[index].label);
					await this.answerCallback(callback.id);
					await this.finalize(sent, `✅ Réponse : ${labels.join(", ")}`, signal);
					return { kind: "multi", answer: null, selected: labels };
				}

				const message = update.message;
				const text = message?.text?.trim();
				if (!message || !text || !this.matchesMessage(message, sent)) continue;
				if (text === "/cancel") {
					await this.finalize(sent, "✖ Question annulée", signal);
					return null;
				}
				await this.finalize(sent, "✅ Réponse libre reçue", signal);
				return { kind: "custom", answer: text };
			}
		}
	}
}
