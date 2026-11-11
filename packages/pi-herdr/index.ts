import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AppHerdr } from "./app";
import type { Exec, Herdr } from "./herdr";
import { registerHerdrTools } from "./tools";
import { TuiHerdr } from "./tui";

/**
 * The Herdr this Pi runs in, told by the environment its pane was started with:
 * a herdr TUI pane (`HERDR_ENV=1`, `HERDR_PANE_ID`) or a Herdr app terminal,
 * which herdr-core starts with `HC_TERMINAL_ID`. Neither: none.
 */
function connect(env: NodeJS.ProcessEnv, exec: Exec): Herdr | null {
	if (env.HERDR_ENV === "1" && env.HERDR_PANE_ID) return new TuiHerdr(exec);
	if (env.HC_TERMINAL_ID) return new AppHerdr(exec, env.HC_TERMINAL_ID);
	return null;
}

/** Registers the Herdr tools when Pi runs inside a Herdr, the TUI or the app. */
export default function (pi: ExtensionAPI) {
	const herdr = connect(process.env, (command, args, options) => pi.exec(command, args, options));
	if (herdr) registerHerdrTools(pi, herdr);
}
