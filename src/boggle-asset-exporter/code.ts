// ═══════════════════════════════════════════════════════════════════════════
// boggle-asset-exporter — Figma 플러그인 메인 스레드
//
// [태스크별 실행 흐름]
//  Step 0. UI 패널 열기
//  Step 1. UI 메시지 수신 → run(task) 호출
//  Step 2. 선택 노드 유효성 검사
//  Step 3. 태스크 분기
//    ├─ "json"        → parseFrameSection + parseBackgroundMeta → export-json
//    ├─ "samples"     → extractImages("samples")               → export-images
//    ├─ "backgrounds" → extractImages("backgrounds")           → export-images
//    ├─ "overlays"    → extractImages("overlays")              → export-images
//    └─ "all"         → runAll() [json + samples + bgs + overlays] → export-all-done
//
// ※ 이 파일은 Figma sandbox(메인 스레드)에서 실행됩니다.
//   DOM/window 접근 불가, postMessage로만 UI와 통신합니다.
// ═══════════════════════════════════════════════════════════════════════════

// ─── Step 0. UI 패널 열기 ────────────────────────────────────────────────────
// __html__은 esbuild 빌드 시 ui.html 내용이 인라인 문자열로 치환됩니다.
figma.showUI(__html__, { width: 420, height: 400, title: "Asset Exporter" });

// ─── 취소 토큰 ────────────────────────────────────────────────────────────────
// Figma 샌드박스는 단일 스레드이므로 AbortController나 Worker를 사용할 수 없습니다.
// 대신 모듈 스코프 플래그(isCancelled)로 취소 신호를 전달하는 협력적 취소 패턴을 사용합니다.
// cancel 메시지 수신 시 플래그를 세우면, 다음 exportPng() 진입 직전의 checkCancelled()가
// CancelledError를 throw해 async 체인 전체를 조기 종료합니다.
// 이미 시작된 exportAsync()는 중단 불가 — 현재 추출이 끝난 직후에 중단됩니다.
let isCancelled = false;

class CancelledError extends Error {
  constructor() {
    super("사용자 취소");
  }
}

function checkCancelled(): void {
  if (isCancelled) throw new CancelledError();
}

// ─── Step 1. UI → 플러그인 메시지 수신 ──────────────────────────────────────
// UI(iframe)에서 parent.postMessage()로 보낸 메시지를 여기서 받습니다.
// "run"    → task 필드에 따라 해당 추출 흐름 시작
// "cancel" → 취소 플래그 설정 후 플러그인 종료
figma.ui.onmessage = async (msg: { type: string; task?: string }) => {
  if (msg.type === "run") {
    isCancelled = false; // 새 실행 전 이전 취소 상태를 초기화합니다.
    // run() 내부 try-catch가 미처 잡지 못한 예외를 위한 최종 방어선입니다.
    try {
      await run(msg.task ?? "json");
    } catch (e) {
      if (e instanceof CancelledError) return; // 취소는 정상 흐름 — 에러로 처리하지 않습니다.
      figma.ui.postMessage({
        type: "error",
        message: `예기치 못한 오류: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }
  if (msg.type === "cancel") {
    isCancelled = true; // run()의 다음 checkCancelled() 지점에서 CancelledError를 발생시킵니다.
    figma.closePlugin();
  }
};

// ─── 타입 정의 ───────────────────────────────────────────────────────────────

type ImageTaskType = "samples" | "backgrounds" | "overlays";

/** frame-options.json 내 단일 슬롯 항목 */
interface SlotData {
  x: number; // 'frame' 레이어 좌측 상단 기준 상대 x 좌표
  y: number; // 'frame' 레이어 좌측 상단 기준 상대 y 좌표
  width: number;
  height: number;
}

/** frame-options.json 내 단일 프레임 항목 */
interface FrameOption {
  id: string; // {frameId} (예: "basic", "wide")
  width: number; // {frameId} 그룹 전체 너비
  height: number; // {frameId} 그룹 전체 높이
  slots: SlotData[]; // 이름순 정렬된 슬롯 배열
}

/** 이미지 추출 결과 — ZIP 경로와 바이너리 데이터를 함께 보관 */
interface ImageAsset {
  path: string; // ZIP 내 가상 경로 (예: "public/images/samples/bg-vangogh.png")
  bytes: Uint8Array; // exportAsync가 반환한 PNG 원시 바이트
}

/** background-options.json 내 단일 배경 항목 */
interface BackgroundOption {
  id: string;
  sampleImageUrl: string; // 썸네일 이미지 경로
  images: Record<string, string>; // frameId → 배경 이미지 경로
  overlays: Record<string, string | null>; // frameId → 오버레이 경로 또는 null
}

// ─── 유틸리티 함수 ───────────────────────────────────────────────────────────

/** 이름이 정확히 일치하는 첫 번째 자식 노드를 반환합니다. */
function findChildByName(
  parent: ChildrenMixin,
  name: string,
): SceneNode | undefined {
  return (parent.children as SceneNode[]).find((c) => c.name === name);
}

/** 이름이 특정 접두사로 시작하는 모든 자식 노드를 반환합니다. */
function findChildrenByNamePrefix(
  parent: ChildrenMixin,
  prefix: string,
): SceneNode[] {
  return (parent.children as SceneNode[]).filter((c) =>
    c.name.startsWith(prefix),
  );
}

/** 노드가 children 속성을 가지는지 확인하는 타입 가드입니다. */
function hasChildren(node: SceneNode): node is SceneNode & ChildrenMixin {
  return "children" in node;
}

/** 노드를 지정 배율의 PNG로 추출하고 원시 바이트를 반환합니다. */
async function exportPng(node: SceneNode, scale: number): Promise<Uint8Array> {
  // exportAsync 시작 전 취소 여부를 확인합니다. 이미 취소됐다면 추출을 시작하지 않습니다.
  checkCancelled();
  // exportAsync는 노드 삭제·export 불가 상태·메모리 초과 등 다양한 원인으로 throw할 수 있습니다.
  // 어느 노드에서 실패했는지 알 수 있도록 노드 이름과 배율 정보를 메시지에 포함해 재전파합니다.
  try {
    const bytes = await node.exportAsync({
      format: "PNG",
      constraint: { type: "SCALE", value: scale },
    });
    // exportAsync 완료 직후에도 재확인합니다. 추출 도중 cancel 메시지가 처리됐을 수 있습니다.
    checkCancelled();
    return bytes;
  } catch (e) {
    if (e instanceof CancelledError) throw e; // 취소는 그대로 상위로 전파합니다.
    throw new Error(
      `"${node.name}" PNG 추출 실패 (scale: ${scale}×): ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

// ─── Step 3-A. FRAME 섹션 파싱 ───────────────────────────────────────────────
// FRAME 섹션의 직접 자식들을 {frameId} 그룹으로 간주하고,
// 각 그룹의 크기와 내부 slot 레이어들의 상대 좌표를 수집합니다.
//
// [레이어 구조 가정]
//   FRAME (섹션)
//   └── basic (frameId 그룹)
//       └── frame (기준 레이어 — slot 좌표의 원점)
//           ├── slot1
//           ├── slot2
//           └── ...

async function parseFrameSection(
  frameSection: SceneNode & ChildrenMixin,
): Promise<Record<string, FrameOption>> {
  const results: Record<string, FrameOption> = {};

  for (const child of frameSection.children as SceneNode[]) {
    // children을 가지지 않는 단순 레이어는 {frameId} 그룹이 아니므로 건너뜁니다.
    if (!hasChildren(child)) continue;

    const frameId = child.name;
    const frameGroupNode = child as SceneNode &
      ChildrenMixin & { width: number; height: number };

    // ── 'frame' 기준 레이어 탐색 ────────────────────────────────────────────
    // 'frame' 레이어의 좌측 상단(x, y)을 slot 좌표 계산의 원점(0, 0)으로 사용합니다.
    const frameLayer = findChildByName(frameGroupNode, "frame");
    let slots: SlotData[] = [];

    if (frameLayer && hasChildren(frameLayer)) {
      const frameLayerWithPos = frameLayer as SceneNode &
        ChildrenMixin & { x: number; y: number };

      const originX = frameLayerWithPos.x;
      const originY = frameLayerWithPos.y;

      // 각 slot의 절대 좌표에서 원점 좌표를 빼면 'frame' 기준 상대 좌표가 됩니다.
      const slotNodes = findChildrenByNamePrefix(frameLayer, "slot");

      slots = [...slotNodes]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((slot) => {
          const s = slot as SceneNode & {
            x: number;
            y: number;
            width: number;
            height: number;
          };
          return {
            x: s.x - originX,
            y: s.y - originY,
            width: s.width,
            height: s.height,
          };
        });
    }

    results[frameId] = {
      id: frameId,
      width: (frameGroupNode as unknown as { width: number }).width,
      height: (frameGroupNode as unknown as { height: number }).height,
      slots,
    };
  }

  return results;
}

// ─── Step 3-B. BACKGROUND 메타데이터 파싱 ────────────────────────────────────
// JSON 태스크 전용. PNG를 추출하지 않고 레이어 구조만 순회해 경로 정보를 구성합니다.
// overlay 레이어의 존재 여부만 확인하여 경로 또는 null을 기록합니다.
//
// [레이어 구조 가정]
//   BACKGROUND (섹션)
//   └── vangogh (backgroundId 그룹)
//       ├── sample
//       ├── basic (frameId 그룹)
//       │   ├── background
//       │   └── overlay (optional)
//       └── wide (frameId 그룹)
//           └── ...

async function parseBackgroundMeta(
  bgSection: SceneNode & ChildrenMixin,
  knownFrameIds: string[],
): Promise<Record<string, BackgroundOption>> {
  const options: Record<string, BackgroundOption> = {};

  for (const bgChild of bgSection.children as SceneNode[]) {
    if (!hasChildren(bgChild)) continue;
    checkCancelled();

    const backgroundId = bgChild.name;
    const bgGroup = bgChild as SceneNode & ChildrenMixin;

    const bgOption: BackgroundOption = {
      id: backgroundId,
      sampleImageUrl: `/images/samples/bg-${backgroundId}.png`,
      images: {},
      overlays: {},
    };

    for (const frameIdChild of bgGroup.children as SceneNode[]) {
      if (!hasChildren(frameIdChild)) continue;
      if (frameIdChild.name === "sample") continue;

      const frameId = frameIdChild.name;
      const frameGroup = frameIdChild as SceneNode & ChildrenMixin;

      bgOption.images[frameId] =
        `/images/backgrounds/${frameId}-${backgroundId}.png`;

      // overlay 레이어 존재 여부만 확인 — PNG 추출은 하지 않습니다.
      const overlayLayer = findChildByName(frameGroup, "overlay");
      bgOption.overlays[frameId] = overlayLayer
        ? `/images/overlays/${frameId}-${backgroundId}.png`
        : null;
    }

    // 특정 배경에 일부 frameId 그룹이 없을 때 JSON 키가 빠지지 않도록 보장합니다.
    for (const fid of knownFrameIds) {
      if (!(fid in bgOption.images)) {
        bgOption.images[fid] = `/images/backgrounds/${fid}-${backgroundId}.png`;
      }
      if (!(fid in bgOption.overlays)) {
        bgOption.overlays[fid] = null;
      }
    }

    options[backgroundId] = bgOption;
  }

  return options;
}

// ─── Step 3-C. 이미지 추출 ───────────────────────────────────────────────────
// samples / backgrounds / overlays 중 지정된 타입만 선택적으로 추출합니다.
// 전체를 한 번에 추출하지 않으므로 postMessage 페이로드 크기가 1/3 수준으로 줄어듭니다.
// 배경 항목 단위로 에러를 격리합니다 — 하나 실패해도 나머지는 계속 처리됩니다.

async function extractImages(
  bgSection: SceneNode & ChildrenMixin,
  taskType: ImageTaskType,
): Promise<ImageAsset[]> {
  const images: ImageAsset[] = [];

  for (const bgChild of bgSection.children as SceneNode[]) {
    if (!hasChildren(bgChild)) continue;
    checkCancelled();

    const backgroundId = bgChild.name;
    const bgGroup = bgChild as SceneNode & ChildrenMixin;

    try {
      if (taskType === "samples") {
        // ── sample 레이어 → 0.5× PNG ────────────────────────────────────────
        const sampleLayer = findChildByName(bgGroup, "sample");
        if (sampleLayer) {
          const bytes = await exportPng(sampleLayer, 0.5);
          images.push({
            path: `public/images/samples/bg-${backgroundId}.png`,
            bytes,
          });
        }
      } else {
        // ── frameId 하위 그룹 순회 ──────────────────────────────────────────
        for (const frameIdChild of bgGroup.children as SceneNode[]) {
          if (!hasChildren(frameIdChild)) continue;
          if (frameIdChild.name === "sample") continue;

          const frameId = frameIdChild.name;
          const frameGroup = frameIdChild as SceneNode & ChildrenMixin;

          if (taskType === "backgrounds") {
            // background 레이어 → 1× PNG
            const bgLayer = findChildByName(frameGroup, "background");
            if (bgLayer) {
              const bytes = await exportPng(bgLayer, 1);
              images.push({
                path: `public/images/backgrounds/${frameId}-${backgroundId}.png`,
                bytes,
              });
            }
          } else {
            // overlay 레이어 → 1× PNG (레이어가 존재하는 경우만)
            const overlayLayer = findChildByName(frameGroup, "overlay");
            if (overlayLayer) {
              const bytes = await exportPng(overlayLayer, 1);
              images.push({
                path: `public/images/overlays/${frameId}-${backgroundId}.png`,
                bytes,
              });
            }
          }
        }
      }
    } catch (e) {
      if (e instanceof CancelledError) throw e; // 취소는 그대로 상위로 전파합니다.
      // 이 배경 항목만 건너뛰고 나머지 항목은 계속 처리합니다.
      console.error(
        `[extractImages] "${backgroundId}" 처리 실패 — 건너뜁니다:`,
        e instanceof Error ? e.message : e,
      );
    }
  }

  return images;
}

// ─── Step 3-D. 전체 생성 ─────────────────────────────────────────────────────
// json → samples → backgrounds → overlays 순서로 순차 실행합니다.
// 각 단계가 완료될 때마다 export-all-part 메시지로 부분 결과를 UI에 전송합니다.
// UI는 수신된 데이터를 누적했다가 export-all-done 신호를 받으면 ZIP을 생성합니다.
// 한 번에 모든 이미지를 postMessage로 전송하면 직렬화 부담이 크므로,
// 타입별로 분리 전송해 메시지 크기를 줄입니다.

async function runAll(
  frameSection: SceneNode & ChildrenMixin,
  bgSection: SceneNode & ChildrenMixin,
): Promise<void> {
  // ── [1/4] JSON ───────────────────────────────────────────────────────────
  figma.ui.postMessage({
    type: "status",
    message: "[1/4] JSON 데이터 파싱 중...",
  });
  const frameOptions = await parseFrameSection(frameSection);
  const knownFrameIds = Object.keys(frameOptions);
  const backgroundOptions = await parseBackgroundMeta(bgSection, knownFrameIds);
  figma.ui.postMessage({
    type: "export-all-part",
    part: "json",
    payload: { frameOptions, backgroundOptions },
  });

  // ── [2/4] Samples ────────────────────────────────────────────────────────
  figma.ui.postMessage({
    type: "status",
    message: "[2/4] 샘플 이미지 추출 중...",
  });
  const samples = await extractImages(bgSection, "samples");
  figma.ui.postMessage({
    type: "export-all-part",
    part: "images",
    payload: {
      images: samples.map((img) => ({
        path: img.path,
        data: Array.from(img.bytes),
      })),
    },
  });

  // ── [3/4] Backgrounds ────────────────────────────────────────────────────
  figma.ui.postMessage({
    type: "status",
    message: "[3/4] 배경 이미지 추출 중...",
  });
  const backgrounds = await extractImages(bgSection, "backgrounds");
  figma.ui.postMessage({
    type: "export-all-part",
    part: "images",
    payload: {
      images: backgrounds.map((img) => ({
        path: img.path,
        data: Array.from(img.bytes),
      })),
    },
  });

  // ── [4/4] Overlays ───────────────────────────────────────────────────────
  figma.ui.postMessage({
    type: "status",
    message: "[4/4] 오버레이 이미지 추출 중...",
  });
  const overlays = await extractImages(bgSection, "overlays");
  figma.ui.postMessage({
    type: "export-all-part",
    part: "images",
    payload: {
      images: overlays.map((img) => ({
        path: img.path,
        data: Array.from(img.bytes),
      })),
    },
  });

  // ── 완료 신호 ────────────────────────────────────────────────────────────
  // UI는 이 신호를 받으면 누적된 데이터로 ZIP을 생성합니다.
  figma.ui.postMessage({ type: "export-all-done" });
}

// ─── Step 2 + 3. 메인 실행 함수 ──────────────────────────────────────────────
// UI에서 "run" 메시지를 받으면 이 함수가 호출됩니다.
// task 값에 따라 json / samples / backgrounds / overlays / all 흐름으로 분기합니다.

async function run(task: string) {
  // ── Step 2. 선택 노드 유효성 검사 ──────────────────────────────────────────
  figma.ui.postMessage({ type: "status", message: "선택 노드 확인 중..." });

  const selection = figma.currentPage.selection;
  if (selection.length !== 1) {
    figma.ui.postMessage({
      type: "error",
      message: "Section 노드 하나만 선택해 주세요.",
    });
    return;
  }

  const root = selection[0];

  if (!hasChildren(root)) {
    figma.ui.postMessage({
      type: "error",
      message: "선택한 노드에 자식 요소가 없습니다.",
    });
    return;
  }

  const rootWithChildren = root as SceneNode & ChildrenMixin;
  const frameSection = findChildByName(rootWithChildren, "FRAME");
  const bgSection = findChildByName(rootWithChildren, "BACKGROUND");

  if (!frameSection || !hasChildren(frameSection)) {
    figma.ui.postMessage({
      type: "error",
      message: "'FRAME' 섹션을 찾을 수 없습니다.",
    });
    return;
  }
  if (!bgSection || !hasChildren(bgSection)) {
    figma.ui.postMessage({
      type: "error",
      message: "'BACKGROUND' 섹션을 찾을 수 없습니다.",
    });
    return;
  }

  // ── Step 3. 태스크 분기 ────────────────────────────────────────────────────
  // 유효성 검사를 통과한 이후의 Figma API 호출에서 발생하는 오류를 일괄 처리합니다.
  try {
    if (task === "json") {
      // JSON 태스크: PNG 추출 없이 레이어 구조만 파싱하므로 매우 빠릅니다.
      figma.ui.postMessage({
        type: "status",
        message: "FRAME 데이터 파싱 중...",
      });
      const frameOptions = await parseFrameSection(
        frameSection as SceneNode & ChildrenMixin,
      );
      const knownFrameIds = Object.keys(frameOptions);

      figma.ui.postMessage({
        type: "status",
        message: "BACKGROUND 메타데이터 파싱 중...",
      });
      const backgroundOptions = await parseBackgroundMeta(
        bgSection as SceneNode & ChildrenMixin,
        knownFrameIds,
      );

      figma.ui.postMessage({
        type: "export-json",
        payload: { frameOptions, backgroundOptions },
      });
    } else if (task === "all") {
      // 전체 생성: json → samples → backgrounds → overlays 순서로 순차 실행합니다.
      await runAll(
        frameSection as SceneNode & ChildrenMixin,
        bgSection as SceneNode & ChildrenMixin,
      );
    } else {
      // 이미지 태스크: 지정된 타입만 추출하므로 전체 추출 대비 데이터 크기가 줄어듭니다.
      const taskType = task as ImageTaskType;
      const statusMap: Record<ImageTaskType, string> = {
        samples: "샘플 이미지 추출 중...",
        backgrounds: "배경 이미지 추출 중...",
        overlays: "오버레이 이미지 추출 중...",
      };
      figma.ui.postMessage({
        type: "status",
        message: statusMap[taskType] + " (시간이 걸릴 수 있습니다)",
      });

      const images = await extractImages(
        bgSection as SceneNode & ChildrenMixin,
        taskType,
      );

      // Uint8Array는 postMessage로 직렬화할 수 없으므로 number[]로 변환합니다.
      // UI에서는 new Uint8Array(data)로 복원합니다.
      figma.ui.postMessage({
        type: "export-images",
        task: taskType,
        payload: {
          images: images.map((img) => ({
            path: img.path,
            data: Array.from(img.bytes),
          })),
        },
      });
    }
  } catch (e) {
    if (e instanceof CancelledError) throw e; // 취소는 onmessage 핸들러로 전파합니다.
    // exportPng()가 재전파한 노드명 포함 메시지도 그대로 UI에 표시됩니다.
    figma.ui.postMessage({
      type: "error",
      message: e instanceof Error ? e.message : `알 수 없는 오류: ${String(e)}`,
    });
  }
}
