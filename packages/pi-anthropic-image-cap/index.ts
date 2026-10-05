import type { ContextEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type AgentMessage = ContextEvent["messages"][number];
type MediaMessage = Extract<AgentMessage, { role: "user" | "toolResult" | "custom" }>;
type Block = Exclude<MediaMessage["content"], string>[number];
type TextContent = Extract<Block, { type: "text" }>;

// Constants from Claude Code 2.1.282, which trims media the same way before every request.
const MIB = 1024 * 1024;
export const MAX_IMAGES = 100;
export const MAX_IMAGES_1M_CONTEXT = 600;
export const COUNT_DROP_BATCH = 20;
export const IMAGE_BYTE_CAP = 32 * MIB - 8 * MIB;
export const BYTE_CAP_HYSTERESIS = 10 * MIB;
export const PLACEHOLDER_TEXT = "[media removed: request limit]";

export interface ImageCapOptions {
	maxImages: number;
	dropBatch: number;
	byteCap: number;
	hysteresis: number;
}

const placeholder = (): TextContent => ({ type: "text", text: PLACEHOLDER_TEXT });

function imageBlocks(message: AgentMessage): Block[] | undefined {
	if (message.role !== "user" && message.role !== "toolResult" && message.role !== "custom") return undefined;
	return Array.isArray(message.content) ? message.content : undefined;
}

/**
 * Returns the oldest-first indexes of images to drop.
 * Dropping in batches (20 images past the count limit, 10 MiB past the byte cap)
 * keeps the request prefix stable between trims, so the prompt cache survives.
 */
export function selectDroppedImages(sizes: number[], options: ImageCapOptions): Set<number> {
	const dropped = new Set<number>();
	const kept: number[] = [];
	const keepAfterCountTrim = Math.max(0, options.maxImages - options.dropBatch);
	let bytes = 0;

	for (const [index, size] of sizes.entries()) {
		kept.push(index);
		bytes += size;

		if (kept.length > options.maxImages) {
			for (const old of kept.splice(0, kept.length - keepAfterCountTrim)) {
				dropped.add(old);
				bytes -= sizes[old];
			}
		}

		if (options.byteCap > 0 && bytes > options.byteCap) {
			for (let k = 0; k < kept.length && bytes > options.byteCap - options.hysteresis; ) {
				const old = kept[k];
				if (sizes[old] === 0) {
					k++;
					continue;
				}
				kept.splice(k, 1);
				dropped.add(old);
				bytes -= sizes[old];
			}
		}
	}

	return dropped;
}

/** Returns the same array when nothing is dropped. Never mutates the input messages. */
export function capImages(messages: AgentMessage[], options: ImageCapOptions): AgentMessage[] {
	const sizes: number[] = [];
	for (const message of messages) {
		for (const block of imageBlocks(message) ?? []) {
			if (block.type === "image") sizes.push(block.data.length);
		}
	}

	const dropped = selectDroppedImages(sizes, options);
	if (dropped.size === 0) return messages;

	let imageIndex = 0;
	return messages.map((message) => {
		const blocks = imageBlocks(message);
		if (!blocks) return message;

		let changed = false;
		const content: Block[] = [];
		for (const block of blocks) {
			if (block.type !== "image" || !dropped.has(imageIndex++)) {
				content.push(block);
				continue;
			}
			changed = true;
			// Claude Code removes loose images outright and replaces images inside tool results.
			if (message.role === "toolResult") content.push(placeholder());
		}

		if (!changed) return message;
		return { ...message, content: content.length > 0 ? content : [placeholder()] } as AgentMessage;
	});
}

export default function anthropicImageCap(pi: ExtensionAPI): void {
	pi.on("context", (event, ctx) => {
		const model = ctx.model;
		// Gate on the wire API, not the provider name, so proxies serving Claude are covered too.
		if (model?.api !== "anthropic-messages") return;

		const messages = capImages(event.messages, {
			maxImages: model.contextWindow > 200_000 ? MAX_IMAGES_1M_CONTEXT : MAX_IMAGES,
			dropBatch: COUNT_DROP_BATCH,
			byteCap: IMAGE_BYTE_CAP,
			hysteresis: BYTE_CAP_HYSTERESIS,
		});
		if (messages !== event.messages) return { messages };
	});
}
