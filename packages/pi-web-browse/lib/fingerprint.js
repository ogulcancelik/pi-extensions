import { execFileSync } from "node:child_process";
import { arch, cpus, platform, release, totalmem, homedir } from "node:os";
import { join } from "node:path";

import { resolveBrowserBin } from "./browser-bin.js";

const DEFAULT_VIEWPORT = { width: 1280, height: 720 };
const NOT_A_BRAND = { brand: "Not/A)Brand", version: "8" };
const NOT_A_BRAND_FULL = { brand: "Not/A)Brand", version: "8.0.0.0" };

function parseLocale(rawLang = "") {
  const normalized = String(rawLang || "").split(".")[0].replace(/_/g, "-").trim();
  if (!normalized) return "en-US";
  return normalized;
}

function buildAcceptLanguage(locale) {
  const primary = String(locale || "en-US").trim() || "en-US";
  const language = primary.split("-")[0] || "en";
  if (primary.toLowerCase() === language.toLowerCase()) {
    return `${primary},en;q=0.9`;
  }
  return `${primary},${language};q=0.9,en;q=0.8`;
}

function bucketDeviceMemory(gib) {
  if (!Number.isFinite(gib) || gib <= 1) return 1;
  if (gib <= 2) return 2;
  if (gib <= 4) return 4;
  return 8;
}

function detectBrowserDetails(preferredBin = null, env = process.env) {
  let browserBin = null;
  let versionOutput = "";

  try {
    browserBin = resolveBrowserBin(preferredBin, env);
    versionOutput = execFileSync(browserBin, ["--version"], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    browserBin = browserBin || preferredBin || null;
  }

  const haystack = `${browserBin || ""} ${versionOutput}`.toLowerCase();
  const versionMatch = versionOutput.match(/(\d+\.\d+\.\d+\.\d+)/);
  const fullVersion = versionMatch?.[1] || "146.0.0.0";
  const majorVersion = fullVersion.split(".")[0] || "146";
  const chromeLikeVersion = `${majorVersion}.0.0.0`;

  if (haystack.includes("brave")) {
    return {
      browserBin,
      browserKind: "brave",
      browserBrand: "Brave",
      fullVersion,
      chromeLikeVersion,
    };
  }

  if (haystack.includes("edge") || haystack.includes("msedge")) {
    return {
      browserBin,
      browserKind: "edge",
      browserBrand: "Microsoft Edge",
      fullVersion,
      chromeLikeVersion,
    };
  }

  if (haystack.includes("chromium")) {
    return {
      browserBin,
      browserKind: "chromium",
      browserBrand: "Chromium",
      fullVersion,
      chromeLikeVersion,
    };
  }

  return {
    browserBin,
    browserKind: "chrome",
    browserBrand: "Google Chrome",
    fullVersion,
    chromeLikeVersion,
  };
}

function getNavigatorPlatform(nodePlatform) {
  if (nodePlatform === "darwin") return "MacIntel";
  if (nodePlatform === "win32") return "Win32";
  return "Linux x86_64";
}

function getUaPlatformToken(nodePlatform) {
  if (nodePlatform === "darwin") return "Macintosh; Intel Mac OS X 10_15_7";
  if (nodePlatform === "win32") return "Windows NT 10.0; Win64; x64";
  return "X11; Linux x86_64";
}

function getUaDataPlatform(nodePlatform) {
  if (nodePlatform === "darwin") return "macOS";
  if (nodePlatform === "win32") return "Windows";
  return "Linux";
}

function getBrands(browserKind, browserBrand, majorVersion) {
  if (browserKind === "chromium") {
    return [NOT_A_BRAND, { brand: "Chromium", version: majorVersion }];
  }

  return [
    NOT_A_BRAND,
    { brand: "Chromium", version: majorVersion },
    { brand: browserBrand, version: majorVersion },
  ];
}

function getFullVersionList(browserKind, browserBrand, chromeLikeVersion, fullVersion) {
  if (browserKind === "chromium") {
    return [NOT_A_BRAND_FULL, { brand: "Chromium", version: fullVersion }];
  }

  return [
    NOT_A_BRAND_FULL,
    { brand: "Chromium", version: chromeLikeVersion },
    { brand: browserBrand, version: fullVersion },
  ];
}

function buildUserAgent(nodePlatform, chromeLikeVersion, userAgentOverride = null) {
  if (userAgentOverride) return userAgentOverride;
  return `Mozilla/5.0 (${getUaPlatformToken(nodePlatform)}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeLikeVersion} Safari/537.36`;
}

export function buildBrowserFingerprint({ preferredBin = null, env = process.env } = {}) {
  const nodePlatform = platform();
  const locale = parseLocale(env.WEB_BROWSE_LOCALE || env.LC_ALL || env.LC_MESSAGES || env.LANG || "en_US.UTF-8");
  const acceptLanguage = env.WEB_BROWSE_ACCEPT_LANGUAGE || buildAcceptLanguage(locale);
  const timezoneId = env.WEB_BROWSE_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const browser = detectBrowserDetails(preferredBin, env);
  const userAgent = buildUserAgent(nodePlatform, browser.chromeLikeVersion, env.WEB_BROWSE_USER_AGENT || null);
  const viewport = DEFAULT_VIEWPORT;
  const cpuCount = Math.max(2, cpus()?.length || 8);
  const totalMemGiB = totalmem() / 1024 / 1024 / 1024;
  const deviceMemory = bucketDeviceMemory(totalMemGiB);
  const majorVersion = browser.fullVersion.split(".")[0] || "146";
  const uaPlatform = getUaDataPlatform(nodePlatform);

  return {
    browserBin: browser.browserBin,
    browserKind: browser.browserKind,
    browserBrand: browser.browserBrand,
    browserFullVersion: browser.fullVersion,
    chromeLikeVersion: browser.chromeLikeVersion,
    userAgent,
    locale,
    acceptLanguage,
    timezoneId,
    navigatorPlatform: getNavigatorPlatform(nodePlatform),
    uaDataPlatform: uaPlatform,
    languages: [locale, locale.split("-")[0] || "en"].filter((value, index, arr) => value && arr.indexOf(value) === index),
    hardwareConcurrency: cpuCount,
    deviceMemory,
    maxTouchPoints: 0,
    colorScheme: env.WEB_BROWSE_COLOR_SCHEME || "light",
    viewport,
    screen: {
      width: viewport.width,
      height: viewport.height,
      availWidth: viewport.width,
      availHeight: viewport.height,
      colorDepth: 24,
      pixelDepth: 24,
    },
    window: {
      outerWidth: viewport.width,
      outerHeight: viewport.height,
      devicePixelRatio: 1,
    },
    userAgentData: {
      brands: getBrands(browser.browserKind, browser.browserBrand, majorVersion),
      mobile: false,
      platform: uaPlatform,
      highEntropyValues: {
        architecture: arch() === "arm64" ? "arm" : "x86",
        bitness: arch().includes("64") ? "64" : "32",
        model: "",
        platform: uaPlatform,
        platformVersion: nodePlatform === "linux" ? "0.0.0" : release(),
        uaFullVersion: browser.browserKind === "chromium" ? browser.fullVersion : browser.chromeLikeVersion,
        fullVersionList: getFullVersionList(
          browser.browserKind,
          browser.browserBrand,
          browser.chromeLikeVersion,
          browser.fullVersion,
        ),
      },
    },
  };
}

export function getDefaultCdpProfileDir(fingerprint, baseHomeDir = homedir()) {
  const browserSuffix = fingerprint?.browserKind || "default";
  return join(baseHomeDir, ".config", `web-browse-cdp-profile-${browserSuffix}`);
}

export function buildFingerprintHeaders(fingerprint) {
  return {
    "User-Agent": fingerprint.userAgent,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": fingerprint.acceptLanguage,
  };
}

export function getFingerprintLaunchArgs(fingerprint) {
  return [
    `--lang=${fingerprint.locale}`,
    `--window-size=${fingerprint.viewport.width},${fingerprint.viewport.height}`,
    `--user-agent=${fingerprint.userAgent}`,
    `--force-device-scale-factor=${fingerprint.window.devicePixelRatio}`,
  ];
}

export async function applyFingerprintToContext(context, fingerprint) {
  if (typeof context.setExtraHTTPHeaders === "function") {
    await context.setExtraHTTPHeaders(buildFingerprintHeaders(fingerprint)).catch(() => {});
  }

  await context.addInitScript((fp) => {
    const defineGetter = (obj, prop, value) => {
      try {
        Object.defineProperty(obj, prop, {
          get: () => value,
          configurable: true,
        });
      } catch {
        // ignore
      }
    };

    defineGetter(navigator, "webdriver", undefined);
    defineGetter(navigator, "userAgent", fp.userAgent);
    defineGetter(navigator, "platform", fp.navigatorPlatform);
    defineGetter(navigator, "language", fp.languages[0]);
    defineGetter(navigator, "languages", fp.languages.slice());
    defineGetter(navigator, "vendor", "Google Inc.");
    defineGetter(navigator, "productSub", "20030107");
    defineGetter(navigator, "hardwareConcurrency", fp.hardwareConcurrency);
    defineGetter(navigator, "deviceMemory", fp.deviceMemory);
    defineGetter(navigator, "maxTouchPoints", fp.maxTouchPoints);
    defineGetter(navigator, "pdfViewerEnabled", true);
    defineGetter(navigator, "plugins", [1, 2, 3, 4, 5]);

    const uaData = {
      brands: fp.userAgentData.brands.map((item) => ({ ...item })),
      mobile: Boolean(fp.userAgentData.mobile),
      platform: fp.userAgentData.platform,
      toJSON() {
        return {
          brands: this.brands,
          mobile: this.mobile,
          platform: this.platform,
        };
      },
      async getHighEntropyValues(hints) {
        const result = {
          brands: this.brands,
          mobile: this.mobile,
          platform: this.platform,
        };

        for (const hint of hints || []) {
          if (hint in fp.userAgentData.highEntropyValues) {
            result[hint] = fp.userAgentData.highEntropyValues[hint];
          }
        }

        return result;
      },
    };

    defineGetter(navigator, "userAgentData", uaData);

    if (window.screen) {
      defineGetter(window.screen, "width", fp.screen.width);
      defineGetter(window.screen, "height", fp.screen.height);
      defineGetter(window.screen, "availWidth", fp.screen.availWidth);
      defineGetter(window.screen, "availHeight", fp.screen.availHeight);
      defineGetter(window.screen, "colorDepth", fp.screen.colorDepth);
      defineGetter(window.screen, "pixelDepth", fp.screen.pixelDepth);
    }

    defineGetter(window, "outerWidth", fp.window.outerWidth);
    defineGetter(window, "outerHeight", fp.window.outerHeight);
    defineGetter(window, "devicePixelRatio", fp.window.devicePixelRatio);

    if (!window.chrome) window.chrome = {};
    if (!window.chrome.runtime) window.chrome.runtime = { id: undefined };
    if (!window.chrome.app) {
      window.chrome.app = {
        isInstalled: false,
        InstallState: {
          DISABLED: "disabled",
          INSTALLED: "installed",
          NOT_INSTALLED: "not_installed",
        },
        RunningState: {
          CANNOT_RUN: "cannot_run",
          READY_TO_RUN: "ready_to_run",
          RUNNING: "running",
        },
      };
    }
    if (!window.chrome.csi) window.chrome.csi = () => ({ startE: Date.now(), onloadT: Date.now(), pageT: 1, tran: 15 });
    if (!window.chrome.loadTimes) {
      window.chrome.loadTimes = () => ({
        commitLoadTime: Date.now() / 1000,
        finishDocumentLoadTime: Date.now() / 1000,
        finishLoadTime: Date.now() / 1000,
        firstPaintAfterLoadTime: 0,
        firstPaintTime: Date.now() / 1000,
        navigationType: "Other",
        npnNegotiatedProtocol: "h2",
        requestTime: Date.now() / 1000,
        startLoadTime: Date.now() / 1000,
        wasAlternateProtocolAvailable: false,
        wasFetchedViaSpdy: true,
        wasNpnNegotiated: true,
      });
    }

    try {
      const permissions = navigator.permissions;
      if (permissions?.query) {
        const originalQuery = permissions.query.bind(permissions);
        permissions.query = (parameters) => {
          if (parameters?.name === "notifications") {
            return Promise.resolve({ state: Notification.permission });
          }
          return originalQuery(parameters);
        };
      }
    } catch {
      // ignore
    }
  }, fingerprint);
}
