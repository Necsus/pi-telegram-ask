import assert from "node:assert/strict";
import test from "node:test";
import {
	buildKeyboard,
	formatQuestionMessage,
	parseCallbackData,
	TelegramClient,
	type TelegramQuestion,
} from "../extensions/telegram.ts";

const question: TelegramQuestion = {
	header: "Database",
	question: "Which database should the service use?",
	options: [
		{ label: "PostgreSQL", description: "Use the existing relational stack." },
		{ label: "SQLite", description: "Keep local development lightweight." },
	],
};

test("formats only bounded project and question context", () => {
	const message = formatQuestionMessage(question, 0, 1, "kurage");
	assert.match(message, /Projet : kurage/);
	assert.match(message, /1\. PostgreSQL/);
	assert.doesNotMatch(message, /preview/);
	assert.ok(message.length <= 3500);
});

test("parses callbacks only for the current question nonce", () => {
	assert.deepEqual(parseCallbackData("piq:abc:option:1", "abc"), { action: "option", optionIndex: 1 });
	assert.deepEqual(parseCallbackData("piq:abc:done", "abc"), { action: "done" });
	assert.equal(parseCallbackData("piq:other:option:1", "abc"), undefined);
	assert.equal(parseCallbackData("piq:abc:option:-1", "abc"), undefined);
});

test("multi-select keyboard reflects selections and requires validation", () => {
	const keyboard = buildKeyboard({ ...question, multiSelect: true }, "nonce", new Set([1]));
	assert.equal(keyboard.inline_keyboard[0][0].text, "☐ PostgreSQL");
	assert.equal(keyboard.inline_keyboard[1][0].text, "☑ SQLite");
	assert.equal(keyboard.inline_keyboard.at(-1)?.[0].callback_data, "piq:nonce:done");
});

test("free-form questions expose cancellation without invented options", () => {
	const keyboard = buildKeyboard({ header: "Decision", question: "What should happen next?" }, "nonce", new Set());
	assert.deepEqual(keyboard.inline_keyboard, [[{ text: "✖ Annuler", callback_data: "piq:nonce:cancel" }]]);
});

test("waits for an authorized Telegram callback and returns its option", async () => {
	const originalFetch = globalThis.fetch;
	const apiResults: unknown[] = [
		[],
		{ message_id: 42, chat: { id: 123, type: "private" } },
		[
			{
				update_id: 7,
				callback_query: {
					id: "callback-1",
					from: { id: 123 },
					data: "piq:nonce:option:0",
					message: { message_id: 42, chat: { id: 123, type: "private" } },
				},
			},
		],
		true,
		{ message_id: 42, chat: { id: 123, type: "private" } },
	];
	globalThis.fetch = async () =>
		new Response(JSON.stringify({ ok: true, result: apiResults.shift() }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});

	try {
		const client = new TelegramClient({
			token: "test-token",
			chatId: 123,
			userId: 123,
			pollTimeoutSeconds: 5,
		});
		await client.initializeOffset();
		const sent = await client.sendQuestion("Question", question, "nonce");
		const answer = await client.waitForAnswer(sent, question, "nonce");
		assert.deepEqual(answer, { kind: "option", answer: "PostgreSQL", preview: undefined });
		assert.equal(apiResults.length, 0);
	} finally {
		globalThis.fetch = originalFetch;
	}
});
