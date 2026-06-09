/**
 * Multi-entry esbuild script.
 *
 * 각 src/<plugin>/ 폴더를 자동으로 감지합니다.
 *   - code.ts  → dist/<plugin>/code.js   (Figma 샌드박스 메인 스레드)
 *   - ui.ts    → dist/<plugin>/ui.html 에 인라인 삽입 (브라우저 UI 스레드)
 *
 * [ui.ts를 별도 파일로 두지 않고 인라인하는 이유]
 * figma.showUI(__html__, ...) 은 HTML을 문자열로 렌더링합니다.
 * 이 경우 <script src="ui.js">처럼 상대 경로로 참조한 외부 스크립트는
 * base URL이 없어 로드되지 않습니다. esbuild로 번들링한 결과를 <script> 태그로
 * ui.html에 직접 삽입해야 Figma 모든 환경(데스크톱·웹)에서 정상 동작합니다.
 *
 * Usage:
 *   node scripts/build.js           # one-shot build
 *   node scripts/build.js --watch   # watch mode
 */

const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

const isWatch = process.argv.includes("--watch");
const isProd = process.env.NODE_ENV === "production";

const srcDir = path.resolve(__dirname, "../src");
const distDir = path.resolve(__dirname, "../dist");

// src/ 하위 디렉터리를 모두 플러그인 후보로 취급합니다.
const pluginDirs = fs
  .readdirSync(srcDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

if (pluginDirs.length === 0) {
  console.error("No plugin directories found under src/");
  process.exit(1);
}

// ── code.ts 빌드 설정 ────────────────────────────────────────────────────────
/** @type {import('esbuild').BuildOptions[]} */
const codeConfigs = pluginDirs
  .filter((name) => fs.existsSync(path.join(srcDir, name, "code.ts")))
  .map((name) => ({
    entryPoints: [path.join(srcDir, name, "code.ts")],
    outfile: path.join(distDir, name, "code.js"),
    bundle: true,
    platform: "browser",
    target: "es2017",
    minify: isProd,
    sourcemap: !isProd ? "inline" : false,
    logLevel: "info",
  }));

// ── ui.html 빌드 (ui.ts 번들을 인라인 삽입) ─────────────────────────────────
/**
 * ui.ts를 번들링하고 그 결과를 ui.html의 <script src="ui.js"> 자리에 인라인합니다.
 * ui.ts가 없는 플러그인은 ui.html만 그대로 복사합니다.
 */
async function buildUiHtml(name) {
  const srcHtml = path.join(srcDir, name, "ui.html");
  if (!fs.existsSync(srcHtml)) return;

  const destPluginDir = path.join(distDir, name);
  fs.mkdirSync(destPluginDir, { recursive: true });

  let htmlContent = fs.readFileSync(srcHtml, "utf-8");

  const uiEntry = path.join(srcDir, name, "ui.ts");
  if (fs.existsSync(uiEntry)) {
    // write: false → 디스크에 쓰지 않고 번들 결과를 메모리에서 받습니다.
    const result = await esbuild.build({
      entryPoints: [uiEntry],
      bundle: true,
      platform: "browser",
      target: "es2017",
      minify: isProd,
      write: false,
      logLevel: "silent",
    });

    const bundledJs = result.outputFiles[0].text;

    // <script src="ui.js"></script> 플레이스홀더를 번들 결과로 교체합니다.
    htmlContent = htmlContent.replace(
      '<script src="ui.js"></script>',
      `<script>\n${bundledJs}</script>`,
    );
    console.log(`Built + inlined ui.ts → dist/${name}/ui.html`);
  } else {
    console.log(`Copied ui.html → dist/${name}/ui.html`);
  }

  fs.writeFileSync(path.join(destPluginDir, "ui.html"), htmlContent);
}

// ── 빌드 진입점 ──────────────────────────────────────────────────────────────
async function build() {
  // ui.html 처리 (ui.ts 인라인 포함)
  await Promise.all(pluginDirs.map(buildUiHtml));

  if (isWatch) {
    // code.ts: esbuild 컨텍스트 watch
    const contexts = await Promise.all(
      codeConfigs.map((cfg) => esbuild.context(cfg)),
    );
    await Promise.all(contexts.map((ctx) => ctx.watch()));
    console.log("Watching for changes...");

    // ui.html / ui.ts: fs.watch로 변경 감지 후 재빌드
    for (const name of pluginDirs) {
      for (const filename of ["ui.html", "ui.ts"]) {
        const watchTarget = path.join(srcDir, name, filename);
        if (!fs.existsSync(watchTarget)) continue;
        fs.watch(watchTarget, () => {
          buildUiHtml(name).catch(console.error);
        });
      }
    }
  } else {
    await Promise.all(codeConfigs.map((cfg) => esbuild.build(cfg)));
    console.log("Build complete.");
  }
}

build().catch((e) => {
  console.error(e);
  process.exit(1);
});
