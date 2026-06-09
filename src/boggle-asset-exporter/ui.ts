// UI 스레드 진입점 — 브라우저(iframe) 환경에서 실행됩니다.
// JSZip을 node_modules에서 직접 import해 번들링하므로 CDN 의존성이 없습니다.
import JSZip from "jszip";

// ── DOM refs ──────────────────────────────────────────────────────────────────
const btnCancel    = document.getElementById("btn-cancel")   as HTMLButtonElement;
const statusBox    = document.getElementById("status-box")   as HTMLDivElement;
const progressWrap = document.getElementById("progress-wrap") as HTMLDivElement;
const progressBar  = document.getElementById("progress-bar")  as HTMLDivElement;
const logEl        = document.getElementById("log")           as HTMLDivElement;
const taskBtns     = document.querySelectorAll<HTMLButtonElement>(".btn-task");

// ── UI helpers ────────────────────────────────────────────────────────────────

function setStatus(msg: string, type = ""): void {
  statusBox.textContent = msg;
  statusBox.className = "visible " + type;
}

function setProgress(pct: number): void {
  progressWrap.classList.add("visible");
  progressBar.style.width = pct + "%";
}

function resetProgress(): void {
  progressWrap.classList.remove("visible");
  progressBar.style.width = "0%";
}

function addLog(msg: string): void {
  const p = document.createElement("p");
  p.textContent = msg;
  logEl.appendChild(p);
  logEl.scrollTop = logEl.scrollHeight;
}

function setBusy(busy: boolean): void {
  taskBtns.forEach((btn) => (btn.disabled = busy));
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ── "전체 생성" 누산기 ────────────────────────────────────────────────────────
// "all" 태스크는 code.ts에서 단계별로 export-all-part 메시지를 여러 번 전송합니다.
// 각 파트를 받을 때마다 누산기에 합산하고, export-all-done 신호 수신 시 ZIP을 생성합니다.
// 한 번에 보내지 않는 이유: 모든 이미지를 하나의 postMessage에 담으면 직렬화 비용이 큽니다.

interface AllAccumulator {
  frameOptions: Record<string, unknown> | null;
  backgroundOptions: Record<string, unknown> | null;
  images: { path: string; data: number[] }[];
}

let allAccumulator: AllAccumulator | null = null;

// ── Task button click ─────────────────────────────────────────────────────────

taskBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    const task = btn.dataset.task;
    logEl.innerHTML = "";
    resetProgress();
    setBusy(true);
    setStatus("선택 노드 확인 중...", "");
    setProgress(5);

    // "all" 태스크는 부분 결과를 누적해야 하므로 누산기를 초기화합니다.
    if (task === "all") {
      allAccumulator = { frameOptions: null, backgroundOptions: null, images: [] };
    }

    parent.postMessage({ pluginMessage: { type: "run", task } }, "*");
  });
});

btnCancel.addEventListener("click", () => {
  parent.postMessage({ pluginMessage: { type: "cancel" } }, "*");
});

// ── Message types ─────────────────────────────────────────────────────────────

interface JsonPayload {
  frameOptions: Record<string, unknown>;
  backgroundOptions: Record<string, unknown>;
}

interface ImagesPayload {
  images: { path: string; data: number[] }[];
}

type PluginMessage =
  | { type: "status"; message: string }
  | { type: "error"; message: string }
  | { type: "export-json"; payload: JsonPayload }
  | { type: "export-images"; task: string; payload: ImagesPayload }
  | { type: "export-all-part"; part: "json"; payload: JsonPayload }
  | { type: "export-all-part"; part: "images"; payload: ImagesPayload }
  | { type: "export-all-done" };

// ── Message handler ───────────────────────────────────────────────────────────

window.onmessage = async (event: MessageEvent) => {
  const msg = (event.data as { pluginMessage?: PluginMessage }).pluginMessage;
  if (!msg) return;

  if (msg.type === "status") {
    setStatus(msg.message, "");
    addLog(msg.message);
    setProgress(30);
    return;
  }

  if (msg.type === "error") {
    setStatus(msg.message, "error");
    setBusy(false);
    resetProgress();
    allAccumulator = null; // 에러 발생 시 누산기를 초기화합니다.
    return;
  }

  if (msg.type === "export-json") {
    await handleExportJson(msg.payload);
    return;
  }

  if (msg.type === "export-images") {
    await handleExportImages(msg.payload, msg.task);
    return;
  }

  if (msg.type === "export-all-part") {
    if (!allAccumulator) return;
    if (msg.part === "json") {
      allAccumulator.frameOptions = msg.payload.frameOptions;
      allAccumulator.backgroundOptions = msg.payload.backgroundOptions;
    } else {
      // 이미지 파트는 타입별로 순차 도착하므로 배열에 누적합니다.
      allAccumulator.images.push(...msg.payload.images);
    }
    return;
  }

  if (msg.type === "export-all-done") {
    const acc = allAccumulator;
    allAccumulator = null;
    if (acc) await handleExportAll(acc);
    return;
  }
};

// ── ZIP builders ──────────────────────────────────────────────────────────────

async function handleExportJson({
  frameOptions,
  backgroundOptions,
}: JsonPayload): Promise<void> {
  setStatus("JSON 파일 패키징 중...", "");
  setProgress(80);

  const zip = new JSZip();

  zip.file(
    "public/locales/frame-options.json",
    JSON.stringify(frameOptions, null, 2),
  );
  addLog(`frame-options.json 생성 (${Object.keys(frameOptions).length}개 프레임)`);

  zip.file(
    "public/locales/background-options.json",
    JSON.stringify(backgroundOptions, null, 2),
  );
  addLog(
    `background-options.json 생성 (${Object.keys(backgroundOptions).length}개 배경)`,
  );

  setProgress(90);

  // PNG가 없으므로 JSON 텍스트에는 DEFLATE 압축이 효과적입니다.
  const blob = await zip.generateAsync({
    type: "blob",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });

  setProgress(100);
  downloadBlob(blob, "project_json.zip");

  setStatus("다운로드 완료! project_json.zip을 확인하세요.", "success");
  addLog("project_json.zip 다운로드 완료");
  setBusy(false);
}

async function handleExportAll(acc: AllAccumulator): Promise<void> {
  setStatus("전체 에셋 패키징 중...", "");
  setProgress(88);

  const zip = new JSZip();

  if (acc.frameOptions) {
    zip.file(
      "public/locales/frame-options.json",
      JSON.stringify(acc.frameOptions, null, 2),
    );
  }
  if (acc.backgroundOptions) {
    zip.file(
      "public/locales/background-options.json",
      JSON.stringify(acc.backgroundOptions, null, 2),
    );
  }
  addLog("JSON 2개 추가");

  for (const img of acc.images) {
    zip.file(img.path, new Uint8Array(img.data), { binary: true });
  }
  addLog(`이미지 ${acc.images.length}개 추가`);

  setProgress(94);

  const blob = await zip.generateAsync({ type: "blob", compression: "STORE" });

  setProgress(100);
  downloadBlob(blob, "project_assets.zip");

  setStatus("다운로드 완료! project_assets.zip을 확인하세요.", "success");
  addLog("project_assets.zip 다운로드 완료");
  setBusy(false);
}

async function handleExportImages(
  { images }: ImagesPayload,
  taskType: string,
): Promise<void> {
  const metaMap: Record<string, { label: string; filename: string }> = {
    samples:     { label: "샘플 이미지",    filename: "samples.zip" },
    backgrounds: { label: "배경 이미지",     filename: "backgrounds.zip" },
    overlays:    { label: "오버레이 이미지", filename: "overlays.zip" },
  };
  const { label, filename } = metaMap[taskType];

  setStatus(`${label} 패키징 중...`, "");
  setProgress(80);

  const zip = new JSZip();
  for (const img of images) {
    // Uint8Array는 postMessage에서 number[]로 직렬화됐으므로 여기서 복원합니다.
    zip.file(img.path, new Uint8Array(img.data), { binary: true });
  }
  addLog(`${label} ${images.length}개 패키징 완료`);

  setProgress(90);

  // PNG는 이미 자체 압축된 포맷이므로 STORE(무압축)로 압축 과정을 생략합니다.
  const blob = await zip.generateAsync({ type: "blob", compression: "STORE" });

  setProgress(100);
  downloadBlob(blob, filename);

  setStatus(`다운로드 완료! ${filename}을 확인하세요.`, "success");
  addLog(`${filename} 다운로드 완료`);
  setBusy(false);
}
