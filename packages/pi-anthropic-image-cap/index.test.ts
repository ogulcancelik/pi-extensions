import { describe, expect, test } from "bun:test";
import anthropicImageCap, {
	type AgentMessage,
	capImages,
	IMAGE_BYTE_CAP,
	type ImageCapOptions,
	PLACEHOLDER_TEXT,
	selectDroppedImages,
} from "./index.ts";

const options = (overrides: Partial<ImageCapOptions> = {}): ImageCapOptions => ({
	maxImages: 100,
	dropBatch: 20,
	byteCap: Number.POSITIVE_INFINITY,
	hysteresis: 0,
	...overrides,
});

const image = (bytes: number) => ({ type: "image" as const, data: "x".repeat(bytes), mimeType: "image/png" });

describe("selectDroppedImages", () => {
	test("keeps everything under both limits", () => {
		expect(selectDroppedImages([10, 10, 10], options({ byteCap: 100 })).size).toBe(0);
	});

	test("drops a batch of the oldest once the count limit is exceeded", () => {
		const dropped = selectDroppedImages(Array(101).fill(1), options());
		expect([...dropped]).toEqual([...Array(21).keys()]);
	});

	test("does not drop again until the count limit is exceeded again", () => {
		expect(selectDroppedImages(Array(120).fill(1), options()).size).toBe(21);
		expect(selectDroppedImages(Array(121).fill(1), options()).size).toBe(21);
		expect(selectDroppedImages(Array(122).fill(1), options()).size).toBe(42);
	});

	test("drops oldest images below the byte cap minus hysteresis", () => {
		const dropped = selectDroppedImages([30, 30, 30, 30], options({ byteCap: 100, hysteresis: 40 }));
		expect([...dropped]).toEqual([0, 1]);
	});
});

describe("capImages", () => {
	test("returns the same array when nothing is dropped", () => {
		const messages: AgentMessage[] = [{ role: "user", content: [image(5)], timestamp: 1 }];
		expect(capImages(messages, options({ byteCap: 100 }))).toBe(messages);
	});

	test("removes user images, replaces tool result images, and leaves the input untouched", () => {
		const user: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: "look" }, image(60)],
			timestamp: 1,
		};
		const imageOnlyUser: AgentMessage = { role: "user", content: [image(60)], timestamp: 2 };
		const toolResult: AgentMessage = {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "screenshot",
			content: [image(60)],
			isError: false,
			timestamp: 3,
		};
		const latest: AgentMessage = { role: "user", content: [image(60)], timestamp: 4 };
		const messages = [user, imageOnlyUser, toolResult, latest];

		const result = capImages(messages, options({ byteCap: 100, hysteresis: 0 }));

		expect(result[0]).toEqual({ ...user, content: [{ type: "text", text: "look" }] });
		expect(result[1]).toEqual({ ...imageOnlyUser, content: [{ type: "text", text: PLACEHOLDER_TEXT }] });
		expect(result[2]).toEqual({ ...toolResult, content: [{ type: "text", text: PLACEHOLDER_TEXT }] });
		expect(result[3]).toBe(latest);
		expect(user.content).toHaveLength(2);
	});
});

describe("context hook", () => {
	type Handler = (event: { messages: AgentMessage[] }, ctx: { model?: unknown }) => { messages: AgentMessage[] } | undefined;

	const register = (): Handler => {
		let handler: Handler | undefined;
		anthropicImageCap({ on: (_event: string, fn: Handler) => (handler = fn) } as never);
		if (!handler) throw new Error("context handler not registered");
		return handler;
	};

	// Two images that together exceed the byte cap, so the older one must go.
	const oversized = (): AgentMessage[] => [
		{ role: "user", content: [image(IMAGE_BYTE_CAP / 2 + 1)], timestamp: 1 },
		{ role: "user", content: [image(IMAGE_BYTE_CAP / 2 + 1)], timestamp: 2 },
	];

	const model = (provider: string, api: string) => ({ provider, api, contextWindow: 200_000 });

	test("trims for any provider speaking the anthropic messages api", () => {
		const handler = register();
		for (const provider of ["anthropic", "cliproxyapi"]) {
			const result = handler({ messages: oversized() }, { model: model(provider, "anthropic-messages") });
			expect(result?.messages[0].content).toEqual([{ type: "text", text: PLACEHOLDER_TEXT }]);
		}
	});

	test("leaves other apis and a missing model alone", () => {
		const handler = register();
		expect(handler({ messages: oversized() }, { model: model("openai", "openai-responses") })).toBeUndefined();
		expect(handler({ messages: oversized() }, {})).toBeUndefined();
	});
});
