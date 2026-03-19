/**
 * Ghostty Theme Sync Extension
 *
 * Syncs pi theme with Ghostty terminal colors on startup.
 * Uses standard ANSI color slot mapping.
 *
 * ANSI slots (consistent across themes):
 *   0: black    8: bright black (gray/muted)
 *   1: red      9: bright red
 *   2: green   10: bright green
 *   3: yellow  11: bright yellow
 *   4: blue    12: bright blue
 *   5: magenta 13: bright magenta
 *   6: cyan    14: bright cyan
 *   7: white   15: bright white
 */

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

interface GhosttyColors {
	background: string;
	foreground: string;
	palette: Record<number, string>;
}

function getGhosttyColors(): GhosttyColors | null {
	try {
		const output = execSync("ghostty +show-config", {
			encoding: "utf-8",
			timeout: 5000,
			stdio: ["pipe", "pipe", "pipe"],
		});
		return parseGhosttyConfig(output);
	} catch {
		return null;
	}
}

function parseGhosttyConfig(output: string): GhosttyColors {
	const colors: GhosttyColors = {
		background: "#1e1e1e",
		foreground: "#d4d4d4",
		palette: {},
	};

	for (const line of output.split("\n")) {
		const match = line.match(/^(\S+)\s*=\s*(.+)$/);
		if (!match) continue;

		const [, key, value] = match;
		const trimmedValue = value.trim();

		if (key === "background") {
			colors.background = normalizeColor(trimmedValue);
		} else if (key === "foreground") {
			colors.foreground = normalizeColor(trimmedValue);
		} else if (key === "palette") {
			const paletteMatch = trimmedValue.match(/^(\d+)=(.+)$/);
			if (paletteMatch) {
				const index = parseInt(paletteMatch[1], 10);
				if (index >= 0 && index <= 15) {
					colors.palette[index] = normalizeColor(paletteMatch[2]);
				}
			}
		}
	}

	return colors;
}

function normalizeColor(color: string): string {
	const trimmed = color.trim();
	if (trimmed.startsWith("#")) {
		if (trimmed.length === 4) {
			return `#${trimmed[1]}${trimmed[1]}${trimmed[2]}${trimmed[2]}${trimmed[3]}${trimmed[3]}`;
		}
		return trimmed;
	}
	if (/^[0-9a-fA-F]{6}$/.test(trimmed)) {
		return `#${trimmed}`;
	}
	return `#${trimmed}`;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
	const h = hex.replace("#", "");
	return {
		r: parseInt(h.substring(0, 2), 16),
		g: parseInt(h.substring(2, 4), 16),
		b: parseInt(h.substring(4, 6), 16),
	};
}

function rgbToHex(r: number, g: number, b: number): string {
	const clamp = (n: number) => Math.round(Math.min(255, Math.max(0, n)));
	return `#${clamp(r).toString(16).padStart(2, "0")}${clamp(g).toString(16).padStart(2, "0")}${clamp(b).toString(16).padStart(2, "0")}`;
}

function getLuminance(hex: string): number {
	const { r, g, b } = hexToRgb(hex);
	return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

function adjustBrightness(hex: string, amount: number): string {
	const { r, g, b } = hexToRgb(hex);
	return rgbToHex(r + amount, g + amount, b + amount);
}

function mixColors(color1: string, color2: string, weight: number): string {
	const c1 = hexToRgb(color1);
	const c2 = hexToRgb(color2);
	return rgbToHex(
		c1.r * weight + c2.r * (1 - weight),
		c1.g * weight + c2.g * (1 - weight),
		c1.b * weight + c2.b * (1 - weight)
	);
}

function generatePiTheme(colors: GhosttyColors, themeName: string): object {
	const bg = colors.background;
	const fg = colors.foreground;
	const isDark = getLuminance(bg) < 0.5;

	// ANSI color slots - trust the standard for semantic colors.
	// Note: we intentionally do NOT use palette[0]/palette[8] as "neutral" colors.
	// Some themes have non-black "black" slots.
	const error = colors.palette[1] || "#cc6666";
	const success = colors.palette[2] || "#98c379";
	const warning = colors.palette[3] || "#e5c07b";
	const link = colors.palette[4] || "#61afef";

	// "Accent" is a judgment call.
	const accent = colors.palette[5] || "#c678dd";
	const accentAlt = colors.palette[6] || "#56b6c2";

	// Derive neutrals from bg/fg for consistent readability across themes
	const muted = mixColors(fg, bg, 0.65);
	const dim = mixColors(fg, bg, 0.45);
	const borderMuted = mixColors(fg, bg, 0.25);

	// Keep bg/fg for export and derived backgrounds
	const _fg = fg;
	const _bg = bg;

	// Derive backgrounds
	const bgShift = isDark ? 12 : -12;
	const selectedBg = adjustBrightness(bg, bgShift);
	const userMsgBg = adjustBrightness(bg, Math.round(bgShift * 0.7));
	const toolPendingBg = adjustBrightness(bg, Math.round(bgShift * 0.4));
	const toolSuccessBg = mixColors(bg, success, 0.88);
	const toolErrorBg = mixColors(bg, error, 0.88);
	const customMsgBg = mixColors(bg, accent, 0.92);

	return {
		$schema: "https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/src/modes/interactive/theme/theme-schema.json",
		name: themeName,
		vars: {
			bg: _bg,
			fg: _fg,
			accent,
			accentAlt,
			link,
			error,
			success,
			warning,
			muted,
			dim,
			borderMuted,
			selectedBg,
			userMsgBg,
			toolPendingBg,
			toolSuccessBg,
			toolErrorBg,
			customMsgBg,
		},
		colors: {
			// Core UI
			accent: "accent",
			border: "link",
			borderAccent: "accent",
			borderMuted: "borderMuted",
			success: "success",
			error: "error",
			warning: "warning",
			muted: "muted",
			dim: "dim",
			text: "",
			thinkingText: "muted",

			// Backgrounds
			selectedBg: "selectedBg",
			userMessageBg: "userMsgBg",
			userMessageText: "",
			customMessageBg: "customMsgBg",
			customMessageText: "",
			customMessageLabel: "accent",
			toolPendingBg: "toolPendingBg",
			toolSuccessBg: "toolSuccessBg",
			toolErrorBg: "toolErrorBg",
			toolTitle: "",
			toolOutput: "muted",

			// Markdown
			mdHeading: "warning",
			mdLink: "link",
			mdLinkUrl: "dim",
			mdCode: "accent",
			mdCodeBlock: "success",
			mdCodeBlockBorder: "muted",
			mdQuote: "muted",
			mdQuoteBorder: "muted",
			mdHr: "muted",
			mdListBullet: "accent",

			// Diffs
			toolDiffAdded: "success",
			toolDiffRemoved: "error",
			toolDiffContext: "muted",

			// Syntax
			syntaxComment: "muted",
			syntaxKeyword: "accent",
			syntaxFunction: "link",
			syntaxVariable: "accentAlt",
			syntaxString: "success",
			syntaxNumber: "accent",
			syntaxType: "accentAlt",
			syntaxOperator: "fg",
			syntaxPunctuation: "muted",

			// Thinking levels
			thinkingOff: "borderMuted",
			thinkingMinimal: "muted",
			thinkingLow: "link",
			thinkingMedium: "accentAlt",
			thinkingHigh: "accent",
			thinkingXhigh: "accent",

			// Bash mode
			bashMode: "success",
		},
		export: {
			pageBg: isDark ? adjustBrightness(bg, -8) : adjustBrightness(bg, 8),
			cardBg: bg,
			infoBg: mixColors(bg, warning, 0.88),
		},
	};
}

function computeThemeHash(colors: GhosttyColors): string {
	const parts: string[] = [];
	parts.push(`bg=${colors.background}`);
	parts.push(`fg=${colors.foreground}`);
	for (let i = 0; i <= 15; i++) {
		parts.push(`p${i}=${colors.palette[i] ?? ""}`);
	}
	const signature = parts.join("\n");
	return createHash("sha1").update(signature).digest("hex").slice(0, 8);
}

function cleanupOldGhosttyThemes(themesDir: string, keepFile: string): void {
	try {
		for (const file of readdirSync(themesDir)) {
			if (file === keepFile) continue;
			if (file === "ghostty-sync.json") {
				// Legacy file name from older versions
				unlinkSync(join(themesDir, file));
				continue;
			}
			if (file.startsWith("ghostty-sync-") && file.endsWith(".json")) {
				unlinkSync(join(themesDir, file));
			}
		}
	} catch {
		// Best-effort cleanup
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		const colors = getGhosttyColors();
		if (!colors) {
			return;
		}

		const themesDir = join(homedir(), ".pi", "agent", "themes");
		if (!existsSync(themesDir)) {
			mkdirSync(themesDir, { recursive: true });
		}

		const hash = computeThemeHash(colors);
		const themeName = `ghostty-sync-${hash}`;
		const themeFile = `${themeName}.json`;
		const themePath = join(themesDir, themeFile);

		// If we're already on the correct synced theme, do nothing.
		// This avoids an extra full-screen repaint on startup.
		if (ctx.ui.theme.name === themeName) {
			return;
		}

		const themeJson = generatePiTheme(colors, themeName);
		writeFileSync(themePath, JSON.stringify(themeJson, null, 2));

		// Remove old generated themes so the themes dir doesn't grow forever.
		cleanupOldGhosttyThemes(themesDir, themeFile);

		// Important: set by name, so pi loads from the file we just wrote.
		const result = ctx.ui.setTheme(themeName);
		if (!result.success) {
			ctx.ui.notify(`Ghostty theme sync failed: ${result.error}`, "error");
		}
	});
}
