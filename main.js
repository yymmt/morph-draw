/**
 * MorphDraw - アプリケーション状態
 */
const state = {
    view: 'gallery',
    currentDrawId: null,
    // 【データ管理システムの設計方針】
    // shapes（図形実体）と beziers（ベジェ曲線）をネストさせずにフラットなマップとして
    // 分離・管理しています。これにより以下のメリットが得られます：
    // 1. 依存関係解決 (Dynamic Bezier Network) の高速化: コネクターが他のベジェに依存する際、
    //    ツリーをスキャンせず state.beziers[id] で一瞬で参照・取得・更新が可能です (DAGの再計算最適化)。
    // 2. 履歴管理 (Undo/Redo) の簡素化: フラットな構造なため、状態のシリアライズや将来的な
    //    パッチ（差分）管理が極めてシンプルになります。
    shapes: {}, // ID -> Shape
    beziers: {},  // ID -> Bezier
    scene: [],    // Root level IDs
    zoom: 1,
    rotation: 0,
    pan: { x: 0, y: 0 },
    history: [],
    historyIndex: -1,
    selectedShapeIds: [],
    anchoredShapeIds: [], // アンカーされた図形ID。オレンジ色で表示。
    focusedVertex: null,   // 現在フォーカスされているベジェ端点（調整ハンドル）。構造: { shapeId, vertexIdx } (vertexIdx: 0〜2N-1)
    dragInfo: null, // { type: 'move'|'pan'|'key-hold'|'drag', ... }
    interaction: {
        mode: null, // 'move', 'scale', 'rotate', 'pan'
        activeKeys: new Set(),
    },
    lastHit: null, // レイヤー操作対象特定用
    lodPrecision: 10, // 編集時10px, 確定時1px
    lastMousePt: null, // 最新のマウス座標
    selectedLayerId: null, // 現在アクティブなレイヤーID
    search: {
        active: false,
        results: [],
        currentIndex: -1
    },
    input: {
        keys: {},           // 押されているキーの状態 { 'm': true, ... }
        pointer: { x: 0, y: 0 }, // 最新のマウス座標
        dragStart: null,    // ドラッグ開始時のポインタ座標
        isPointerDown: false, // ポインタが押されているか
        isHoveringMinimap: false // 新規：ミニマップ上にマウスがあるか
    },
    minimap: {
        zoom: 1.0           // 新規：ミニマップのズーム倍率
    },
    canvas: {
        width: 2000,
        height: 2000,
        underOffscreen: null,
        activeOffscreen: null,
        overOffscreen: null
    }
}; /* state */

state.nextIdCounter = 1;

function initializeIdCounter() {
    let max = 0;
    const scan = (id) => {
        if (!id) return;
        const match = id.match(/[0-9]+/);
        if (match) {
            const num = parseInt(match[0], 10);
            if (!isNaN(num) && num > max) {
                max = num;
            }
        }
    };
    Object.keys(state.shapes).forEach(scan);
    Object.keys(state.beziers).forEach(scan);
    state.nextIdCounter = max + 1;
}

function generateId(prefix) {
    if (!state.nextIdCounter) state.nextIdCounter = 1;
    const id = `${prefix}${state.nextIdCounter}`;
    state.nextIdCounter++;
    return id;
}

function stateReplacer(key, value) {
    if (key === 'controlPoints' || key === 'samplePointByT' || key === 'boundingBox') {
        return undefined;
    }
    if (typeof value === 'number') {
        return Math.round(value * 10000) / 10000;
    }
    return value;
}

const KAPPA = 0.552284749831;
const PI2 = Math.PI * 2;

let db; /* IndexedDB インスタンス */

document.addEventListener('DOMContentLoaded', () => {
    initDB();
    initOffscreenCanvases();
    initEvents();
});

function initOffscreenCanvases() {
    state.canvas.underOffscreen = document.createElement('canvas');
    state.canvas.underOffscreen.width = state.canvas.width;
    state.canvas.underOffscreen.height = state.canvas.height;

    state.canvas.activeOffscreen = document.createElement('canvas');
    state.canvas.activeOffscreen.width = state.canvas.width;
    state.canvas.activeOffscreen.height = state.canvas.height;

    state.canvas.overOffscreen = document.createElement('canvas');
    state.canvas.overOffscreen.width = state.canvas.width;
    state.canvas.overOffscreen.height = state.canvas.height;
}

function initEvents() {
    document.getElementById('btn-new-draw').onclick = () => {
        startNewDrawing();
    }; /* btn-new-draw.onclick */

    document.getElementById('btn-back-gallery').onclick = async () => {
        await saveDrawing();
        loadGallery();
        switchView('gallery');
    }; /* btn-back-gallery.onclick */
    // MEMO: qキーで戻れればよいので、 <button id="btn-back-gallery" class="icon-btn"><i class="bi bi-chevron-left"></i></button> もいったん削除しようかな。
    // <aside class="toolbar-left">が空になるが、さすがに何かしらボタンにしたいかもしれないから、一応この黒帯は残しておこう。

    document.getElementById('btn-toggle-minimap').onclick = () => {
        const panel = document.getElementById('minimap-panel');
        panel.classList.toggle('collapsed');
        const icon = document.querySelector('#btn-toggle-minimap i');
        if (icon) {
            const isCollapsed = panel.classList.contains('collapsed');
            icon.className = `bi ${isCollapsed ? 'bi-chevron-double-left' : 'bi-chevron-double-right'}`;
        }
    }; /* btn-toggle-minimap.onclick */

    const svg = document.getElementById('main-svg');
    const minimapCanvas = document.getElementById('minimap-canvas');

    svg.addEventListener('pointerdown', (e) => {
        const viewport = svg.getElementById('viewport') || svg;
        const startPt = getSVGPoint(e, viewport);
        state.input.isPointerDown = true;
        state.input.dragStart = startPt;
        handleInputUpdate('pointerdown');
    }); /* svg.pointerdown */

    if (minimapCanvas) {
        minimapCanvas.addEventListener('pointerdown', (e) => {
            state.input.isPointerDown = true;
            // ミニマップ上の pointerdown 時も getSVGPoint で座標変換して dragStart に入れる
            const pt = getSVGPoint(e, svg.getElementById('viewport') || svg);
            state.input.dragStart = pt;
            handleInputUpdate('pointerdown');
        });
    }

    window.addEventListener('pointermove', (e) => {
        const pt = getSVGPoint(e, svg.getElementById('viewport') || svg);
        state.input.pointer = { x: pt.x, y: pt.y };
        state.lastMousePt = { x: pt.x, y: pt.y };
        handleInputUpdate('pointermove');
    }); /* window.pointermove */

    const stop = (e) => {
        state.input.isPointerDown = false;
        state.input.dragStart = null;
        handleInputUpdate('pointerup');
    }; /* stop */
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);

    window.addEventListener('keydown', async e => {
        if (e.repeat) return;
        if (document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA' || document.activeElement.isContentEditable)) {
            return;
        }
        state.input.keys[e.key] = true;
        await handleInputUpdate('keydown', e.key, e);
    }); /* window.keydown */

    window.addEventListener('keyup', async e => {
        if (document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA' || document.activeElement.isContentEditable)) {
            return;
        }
        state.input.keys[e.key] = false;
        await handleInputUpdate('keyup', e.key, e);
    }); /* window.keyup */

    document.getElementById('btn-close-help').onclick = () => {
        toggleHelpModal();
    }; /* btn-close-help.onclick */

    document.getElementById('help-modal').onclick = (e) => {
        if (e.target === document.getElementById('help-modal')) {
            toggleHelpModal();
        }
    }; /* help-modal.onclick */

    document.getElementById('btn-add-layer').onclick = () => {
        addLayer();
    }; /* btn-add-layer.onclick */

    // 検索入力イベントハンドラ
    const searchInput = document.getElementById('search-input');
    if (searchInput) {
        searchInput.oninput = () => {
            performSearch(searchInput.value);
            applySearchResult();
        };
        searchInput.onkeydown = (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                closeSearchMode(true);
            } else if (e.key === 'Escape') {
                e.preventDefault();
                closeSearchMode(false);
            } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                if (state.search.results.length > 0) {
                    state.search.currentIndex = (state.search.currentIndex + 1) % state.search.results.length;
                    applySearchResult();
                }
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                if (state.search.results.length > 0) {
                    state.search.currentIndex = (state.search.currentIndex - 1 + state.search.results.length) % state.search.results.length;
                    applySearchResult();
                }
            }
        };
        searchInput.onblur = () => {
            setTimeout(() => {
                if (state.search.active) {
                    closeSearchMode(true);
                }
            }, 200);
        };
    }

    // ミニマップホバー判定の登録
    if (minimapCanvas) {
        minimapCanvas.addEventListener('mouseenter', () => {
            state.input.isHoveringMinimap = true;
        });
        minimapCanvas.addEventListener('mouseleave', () => {
            state.input.isHoveringMinimap = false;
        });
    }
} /* initEvents */

/**
 * 共通ヘルパー: モディファイア状態を取得
 */
function getModifierState(rawEvent) {
    if (!rawEvent) return 'no_mod';
    const ctrl = rawEvent.ctrlKey || rawEvent.metaKey;
    const shift = rawEvent.shiftKey;
    if (ctrl && shift) return 'ctrl_shift';
    if (ctrl) return 'ctrl';
    if (shift) return 'shift';
    return 'no_mod';
}

/**
 * 各種キー・ポインタハンドラー関数
 */

// 円の追加
function handleAddCircleStart(ctx) {
    addShapeAt('circle', state.input.pointer.x, state.input.pointer.y);
}

// Wrap（接続ベジェ）の生成
function handleCreateWrap(ctx) {
    createWrap();
}

// Undo
function handleUndoAction(ctx) {
    undo();
}

// Redo
function handleRedoAction(ctx) {
    redo();
}

// ギャラリーへ戻る（非同期）
async function handleQuitToGallery(ctx) {
    if (state.view === 'canvas') {
        await saveDrawing();
        loadGallery();
        switchView('gallery');
    }
}

// 検索モードの起動
function handleOpenSearch(ctx) {
    if (ctx.rawEvent) ctx.rawEvent.preventDefault();
    openSearchMode();
}

// 検索結果の次を選択
function handleSearchNext(ctx) {
    if (state.search.results.length > 0) {
        state.search.currentIndex = (state.search.currentIndex + 1) % state.search.results.length;
        applySearchResult();
    }
}

// 検索結果の前を選択
function handleSearchPrev(ctx) {
    if (state.search.results.length > 0) {
        state.search.currentIndex = (state.search.currentIndex - 1 + state.search.results.length) % state.search.results.length;
        applySearchResult();
    }
}

// 接続点のフォーカス（前へ）
function handleFocusVertexPrev(ctx) {
    if (ctx.rawEvent) ctx.rawEvent.preventDefault();
    moveVertexFocus(-1);
}

// 接続点のフォーカス（次へ）
function handleFocusVertexNext(ctx) {
    if (ctx.rawEvent) ctx.rawEvent.preventDefault();
    moveVertexFocus(1);
}

// 接続点フォーカスの移動ロジック
function moveVertexFocus(dir) {
    if (state.selectedShapeIds.length > 0) {
        const shapeId = state.selectedShapeIds[0];
        const shape = state.shapes[shapeId];
        if (shape && shape.name && shape.name.startsWith('wrap') && shape.bezierIds && shape.bezierIds.length > 0) {
            const numHandles = shape.bezierIds.length * 2;
            if (state.focusedVertex === null || state.focusedVertex === undefined) {
                state.focusedVertex = { shapeId, vertexIdx: 0 };
            } else {
                const currIdx = state.focusedVertex.vertexIdx;
                const nextIdx = (currIdx + dir + numHandles) % numHandles;
                state.focusedVertex = { shapeId, vertexIdx: nextIdx };
            }
        }
    }
}

// 接続点のフォーカス解除
function handleClearVertexFocus(ctx) {
    if (state.focusedVertex) {
        state.focusedVertex = null;
    }
}

// アンカーのトグル、または頂点追加待ち状態への移行
function handleToggleAnchor(ctx) {
    if (state.focusedVertex) {
        state.insertVertexPending = { ...state.focusedVertex };
        return { pushHistory: false, needsRender: false };
    }
    state.selectedShapeIds.forEach(id => {
        const idx = state.anchoredShapeIds.indexOf(id);
        if (idx >= 0) {
            state.anchoredShapeIds.splice(idx, 1);
        } else {
            state.anchoredShapeIds.push(id);
        }
    });
    return { pushHistory: true, needsRender: true };
}

// 変形開始 (m, s, r, t, d, z 押下時)
function handleTransformStart(ctx) {
    const key = ctx.detail;
    const modeMap = { m: 'move', s: 'scale', r: 'rotate', t: 't-slide', d: 'd-dist', z: 'zoom' };
    const desiredMode = modeMap[key] || null;

    if (desiredMode !== state.interaction.mode) {
        const hasTarget = desiredMode === 'zoom' || state.selectedShapeIds.length > 0 || (state.focusedVertex && (desiredMode === 't-slide' || desiredMode === 'd-dist'));
        if (hasTarget) {
            state.dragInfo = {
                start: { ...state.input.pointer },
                type: 'key-hold'
            };
        }
        state.interaction.mode = desiredMode;
    }
}

// 変形終了 (キーリリース時)
function handleTransformEnd(ctx) {
    const key = ctx.detail;
    const modeMap = { m: 'move', s: 'scale', r: 'rotate', t: 't-slide', d: 'd-dist', z: 'zoom' };
    const mappedMode = modeMap[key];

    if (mappedMode === state.interaction.mode) {
        state.interaction.mode = null;
        if (state.dragInfo) {
            state.dragInfo = null;
            return { pushHistory: true, needsRender: true };
        }
    }
    return { pushHistory: false, needsRender: false };
}

// pointerdown 時の共通処理
function handlePointerDownStart(ctx) {
    if (state.interaction.mode === null) {
        const hit = findShapeAt(state.input.dragStart);
        state.lastHit = hit;
        if (hit) {
            if (!state.selectedShapeIds.includes(hit.shape.id)) {
                state.selectedShapeIds = [hit.shape.id];
                state.focusedVertex = null; // 図形選択変更時に頂点フォーカスをクリア
            }
        }
    } else {
        state.dragInfo = {
            start: { ...state.input.dragStart },
            type: 'drag'
        };
    }
}

// pointerup 時の共通処理
function handlePointerUpEnd(ctx) {
    let needsRender = false;
    let pushHistory = false;

    if (state.interaction.mode) {
        pushHistory = true;
        needsRender = true;
    } else if (state.dragInfo && !state.lastHit) {
        state.selectedShapeIds = [];
        state.focusedVertex = null; // 頂点フォーカスもクリア
        needsRender = true;
    }
    state.dragInfo = null;
    return { needsRender, pushHistory };
}

// 変形処理: 移動
function handleMove(ctx) {
    if (state.selectedShapeIds.length > 0) {
        state.selectedShapeIds.forEach(id => {
            if (state.shapes[id]) moveShape(id, ctx.dx, ctx.dy);
        });
    }
}

// 変形処理: 拡大縮小
function handleScale(ctx) {
    if (state.selectedShapeIds.length > 0) {
        const scaleFactor = 1 + ctx.dx * 0.01;
        state.selectedShapeIds.forEach(id => {
            if (state.shapes[id]) scaleShape(id, scaleFactor);
        });
    }
}

// 変形処理: 回転
function handleRotate(ctx) {
    if (state.selectedShapeIds.length > 0) {
        const angle = ctx.dx * 0.5; // degrees
        state.selectedShapeIds.forEach(id => {
            if (state.shapes[id]) rotateShape(id, angle);
        });
    }
}

// 変形処理: t値スライド (頂点スライド)
function handleTSlide(ctx) {
    if (state.focusedVertex) {
        const { shapeId, vertexIdx } = state.focusedVertex;
        const shape = state.shapes[shapeId];
        if (shape && shape.bezierIds && shape.bezierIds.length > 0) {
            const N = shape.bezierIds.length;
            const vIdx = Math.floor((vertexIdx + 1) / 2) % N;
            const idx1 = (vIdx - 1 + N) % N;
            const idx2 = vIdx;

            const bid1 = shape.bezierIds[idx1];
            const bid2 = shape.bezierIds[idx2];
            const bez1 = state.beziers[bid1];
            const bez2 = state.beziers[bid2];

            if (bez1 && bez2 && bez1.generator && bez2.generator && bez1.generator.params && bez2.generator.params) {
                const param1 = bez1.generator.params.src2;
                const param2 = bez2.generator.params.src1;

                if (param1 && param2) {
                    param2.t += ctx.dx * 0.01;

                    const srcBezierId = param2.bezierId;
                    const srcShapeId = Object.keys(state.shapes).find(id => {
                        const s = state.shapes[id];
                        return s.bezierIds && s.bezierIds.includes(srcBezierId);
                    });

                    if (srcShapeId) {
                        const srcShape = state.shapes[srcShapeId];
                        const currentSrcIdx = srcShape.bezierIds.indexOf(srcBezierId);

                        if (currentSrcIdx >= 0) {
                            while (param2.t > 1) {
                                const nextIdx = (currentSrcIdx + 1) % srcShape.bezierIds.length;
                                param2.bezierId = srcShape.bezierIds[nextIdx];
                                param2.t -= 1;
                            }
                            while (param2.t < 0) {
                                const prevIdx = (currentSrcIdx - 1 + srcShape.bezierIds.length) % srcShape.bezierIds.length;
                                param2.bezierId = srcShape.bezierIds[prevIdx];
                                param2.t += 1;
                            }
                        }
                    }

                    param1.bezierId = param2.bezierId;
                    param1.t = param2.t;

                    resolveBezierDependencies();
                }
            }
        }
    }
}

// 変形処理: d値スライド (頂点接線距離)
function handleDDist(ctx) {
    if (state.focusedVertex) {
        const { shapeId, vertexIdx } = state.focusedVertex;
        const shape = state.shapes[shapeId];
        if (shape && shape.bezierIds && shape.bezierIds.length > 0) {
            const bezierIdx = Math.floor(vertexIdx / 2) % shape.bezierIds.length;
            const bid = shape.bezierIds[bezierIdx];
            const bez = state.beziers[bid];
            if (bez && bez.generator && bez.generator.params) {
                const delta = ctx.dx * 0.1;
                if (vertexIdx % 2 === 0) {
                    bez.generator.params.d1 += delta;
                } else {
                    bez.generator.params.d2 += delta;
                }
                resolveBezierDependencies();
            }
        }
    }
}

// 変形処理: ズーム (メインキャンバス / ミニマップ)
function handleZoom(ctx) {
    const zoomFactor = 1 - ctx.dy * 0.01;

    // MEMO: 将来対応として、ズーム操作中にマウスポインタを固定させたい場合は、pointerdownイベントなどのユーザーインタラクションのコールバック内でPointer Lock API (requestPointerLock) を呼び出して制御することを検討する。
    if (state.input.isHoveringMinimap) {
        // ミニマップのズーム
        state.minimap.zoom = Math.max(0.1, Math.min(10, state.minimap.zoom * zoomFactor));
    } else {
        // メインキャンバスのズーム (ポインタ座標を中心にズーム)
        const oldZoom = state.zoom;
        state.zoom = Math.max(0.1, Math.min(20, state.zoom * zoomFactor));

        // ポインタ座標 (キャンバス座標系)
        const p = state.input.pointer;
        state.pan.x += p.x * (oldZoom - state.zoom);
        state.pan.y += p.y * (oldZoom - state.zoom);
    }
}

// キーボードイベントハンドラ定義
const keyHandlers = {
    no_mod: {
        x: { keydown: { f: deleteSelectedShapes } },
        c: { keydown: { f: handleAddCircleStart, needsRender: true } },
        w: { keydown: { f: handleCreateWrap, pushHistory: true, needsRender: true } },
        u: { keydown: { f: handleUndoAction, needsRender: true } },
        '?': { keydown: { f: toggleHelpModal, needsRender: true } },
        q: { keydown: { f: handleQuitToGallery, needsRender: false } },
        '/': { keydown: { f: handleOpenSearch, needsRender: false } },
        n: { keydown: { f: handleSearchNext, needsRender: true } },
        N: { keydown: { f: handleSearchPrev, needsRender: true } },
        ArrowLeft: { keydown: { f: handleFocusVertexPrev, needsRender: true } },
        ArrowRight: { keydown: { f: handleFocusVertexNext, needsRender: true } },
        Escape: { keydown: { f: handleClearVertexFocus, needsRender: true } },
        a: { keydown: { f: handleToggleAnchor } },
        Enter: { keydown: { f: handleEnterAction } },

        m: {
            keydown: { f: handleTransformStart, needsRender: true },
            keyup: { f: handleTransformEnd, pushHistory: true, needsRender: true }
        },
        s: {
            keydown: { f: handleTransformStart, needsRender: true },
            keyup: { f: handleTransformEnd, pushHistory: true, needsRender: true }
        },
        r: {
            keydown: { f: handleTransformStart, needsRender: true },
            keyup: { f: handleTransformEnd, pushHistory: true, needsRender: true }
        },
        t: {
            keydown: { f: handleTransformStart, needsRender: true },
            keyup: { f: handleTransformEnd, pushHistory: true, needsRender: true }
        },
        d: {
            keydown: { f: handleTransformStart, needsRender: true },
            keyup: { f: handleTransformEnd, pushHistory: true, needsRender: true }
        },
        z: {
            keydown: { f: handleTransformStart, needsRender: true },
            keyup: { f: handleTransformEnd, pushHistory: true, needsRender: true }
        }
    },
    ctrl: {
        r: { keydown: { f: handleRedoAction, needsRender: true } }
    }
};

// モードごとのポインタ移動イベントハンドラ定義
const modeHandlers = {
    move: {
        pointermove: { f: handleMove, needsRender: true }
    },
    scale: {
        pointermove: { f: handleScale, needsRender: true }
    },
    rotate: {
        pointermove: { f: handleRotate, needsRender: true }
    },
    't-slide': {
        pointermove: { f: handleTSlide, needsRender: true }
    },
    'd-dist': {
        pointermove: { f: handleDDist, needsRender: true }
    },
    zoom: {
        pointermove: { f: handleZoom, needsRender: true }
    }
};

async function handleInputUpdate(event, detail, rawEvent) {
    let needsRender = false;
    let shouldPushHistory = false;

    const modifier = getModifierState(rawEvent);
    const ctx = {
        event,
        detail,
        rawEvent,
        dx: 0,
        dy: 0
    };

    // 1. キーイベント (keydown / keyup) のディスパッチ
    if (event === 'keydown' || event === 'keyup') {
        const handlerGroup = keyHandlers[modifier]?.[detail];
        const config = handlerGroup?.[event];

        if (config && config.f) {
            const res = await config.f(ctx);
            if (config.needsRender || (res && res.needsRender)) needsRender = true;
            if (config.pushHistory || (res && res.pushHistory)) shouldPushHistory = true;
        }
    }
    // 2. ポインタイベント (pointerdown / pointermove / pointerup) のディスパッチ
    else {
        const mode = state.interaction.mode;

        if (event === 'pointerdown') {
            handlePointerDownStart(ctx);
            needsRender = true;
        }

        else if (event === 'pointermove') {
            if (state.dragInfo) {
                const pt = state.input.pointer;
                ctx.dx = pt.x - state.dragInfo.start.x;
                ctx.dy = pt.y - state.dragInfo.start.y;

                if (ctx.dx !== 0 || ctx.dy !== 0) {
                    const config = modeHandlers[mode]?.pointermove;
                    if (config && config.f) {
                        await config.f(ctx);
                        state.dragInfo.start = { ...pt };
                        if (config.needsRender) needsRender = true;
                        if (config.pushHistory) shouldPushHistory = true;
                    }
                }
            }
        }

        else if (event === 'pointerup') {
            const res = handlePointerUpEnd(ctx);
            if (res.needsRender) needsRender = true;
            if (res.pushHistory) shouldPushHistory = true;
        }
    }

    if (shouldPushHistory) {
        pushHistory();
    }
    if (needsRender) {
        renderCanvas();
    }
} /* handleInputUpdate */

function toggleHelpModal() {
    const modal = document.getElementById('help-modal');
    modal.classList.toggle('hidden');
} /* toggleHelpModal */

function pushHistory() {
    const current = JSON.stringify({
        shapes: state.shapes,
        beziers: state.beziers,
        scene: state.scene,
        anchoredShapeIds: state.anchoredShapeIds,
        focusedVertex: state.focusedVertex,
        selectedShapeIds: state.selectedShapeIds,
        selectedLayerId: state.selectedLayerId
    }, stateReplacer);
    if (state.historyIndex >= 0 && current === state.history[state.historyIndex]) return;
    state.history = state.history.slice(0, state.historyIndex + 1);
    state.history.push(current);
    state.historyIndex = state.history.length - 1;
} /* pushHistory */

function undo() {
    if (state.historyIndex <= 0) return;
    state.historyIndex--;
    const data = JSON.parse(state.history[state.historyIndex]);
    state.shapes = data.shapes || data.entities || {};
    state.beziers = data.beziers;
    state.scene = data.scene;
    state.anchoredShapeIds = data.anchoredShapeIds || [];
    state.focusedVertex = data.focusedVertex || null;

    // MEMO: 「選択→移動→Undo」を行った際に選択状態が解除されてしまう問題（履歴記録時の選択状態の保存タイミングのズレ）は将来対応とする。
    state.selectedShapeIds = (data.selectedShapeIds || []).filter(id => state.shapes[id]);
    state.selectedLayerId = data.selectedLayerId && state.shapes[data.selectedLayerId] ? data.selectedLayerId : null;

    resolveBezierDependencies();
    renderCanvas();
} /* undo */

function redo() {
    if (state.historyIndex >= state.history.length - 1) return;
    state.historyIndex++;
    const data = JSON.parse(state.history[state.historyIndex]);
    state.shapes = data.shapes || data.entities || {};
    state.beziers = data.beziers;
    state.scene = data.scene;
    state.anchoredShapeIds = data.anchoredShapeIds || [];
    state.focusedVertex = data.focusedVertex || null;
    state.selectedShapeIds = (data.selectedShapeIds || []).filter(id => state.shapes[id]);
    state.selectedLayerId = data.selectedLayerId && state.shapes[data.selectedLayerId] ? data.selectedLayerId : null;

    resolveBezierDependencies();
    renderCanvas(); /* redo */

    // MEMO
    // undo, undo, redo としたとき、 state.historyIndex 以降のhistoryを消す必要があるかも。
    // historyはjs変数上のみなのでJSON化する必要ない。

    // MEMO
    // 差分管理にしようか悩ましいところ。
    // selectedShapeIds はたぶん急激に増えたり減ったりするので、差分じゃないほうがいいかも。
    // 選択以外の、差分管理にしたい操作を {関数名,引数リスト} のhistoryにして持たせるのがいいかしら。
    // 「スライダー」のように、マウスの移動に連動して連続して動かしている場合は、historyが増えすぎるのを防ぐために、確定時(mouseupかkeyup)の時のみhistoryに追加するような工夫が必要か。(現状stop関数でやってるか。)

    // MEMO
    // undo, redo 時、selectedShapeIds も復元したいところ。
    // 将来的に、フォーカスしているレイヤーのみ<svg>DOM、フォーカスしていないレイヤーは<canvas>にラスタライズしておいて描画を高速化する必要がある気がするので、undo, redo時はフォーカスしているレイヤーも復元するようにしたほうがよい。
} /* redo */

function findClosestSamplePoint(pt) {
    // 表示されているレイヤーに属するShapeのIDを収集
    const visibleShapeIds = new Set();
    state.scene.forEach(layerId => {
        const layer = state.shapes[layerId];
        if (layer && layer.type === 'layer' && layer.visible !== false) {
            layer.childIds?.forEach(id => visibleShapeIds.add(id));
        }
    });

    let closest = null, minD = 25;
    for (const [sid, shape] of Object.entries(state.shapes)) {
        if (!shape.bezierIds) continue;
        if (!visibleShapeIds.has(sid)) continue; // 非表示レイヤーの図形は選択対象外

        shape.bezierIds.forEach(bid => {
            const b = state.beziers[bid];
            if (!b) return;
            Object.entries(b.samplePointByT).forEach(([tStr, p]) => {
                const d = Math.hypot(p.x - pt.x, p.y - pt.y);
                if (d < minD) { minD = d; closest = { shapeId: sid, bezierId: bid, t: parseFloat(tStr), pt: p }; }
            });
        });
    }
    return closest; /* findClosestSamplePoint */
} /* findClosestSamplePoint */

function findShapeAt(pt) {
    const h = findClosestSamplePoint(pt);
    if (!h) return null;
    const shapeId = Object.keys(state.shapes).find(id => state.shapes[id].bezierIds?.includes(h.bezierId));
    return shapeId ? { shape: state.shapes[shapeId], child: null } : null;
} /* findShapeAt */



function deleteSelectedShapes() {
    if (state.focusedVertex) {
        const { shapeId, vertexIdx } = state.focusedVertex;
        const shape = state.shapes[shapeId];
        if (shape && shape.bezierIds && shape.bezierIds.length > 3) {
            deleteVertex(shapeId, vertexIdx);
            return { pushHistory: true, needsRender: true };
        }
        return { pushHistory: false, needsRender: false };
    }

    if (state.selectedShapeIds.length === 0) return { pushHistory: false, needsRender: false };

    // 各レイヤーからShapeを削除
    state.scene.forEach(layerId => {
        const layer = state.shapes[layerId];
        if (layer && layer.type === 'layer') {
            layer.childIds = layer.childIds.filter(id => !state.selectedShapeIds.includes(id));
        }
    });

    // state.shapes および state.beziers からも削除
    state.selectedShapeIds.forEach(shapeId => {
        const shape = state.shapes[shapeId];
        if (shape) {
            shape.bezierIds?.forEach(bid => delete state.beziers[bid]);
            delete state.shapes[shapeId];
        }
    });

    state.selectedShapeIds = [];
    state.focusedVertex = null; // 頂点フォーカスもクリア
    return { pushHistory: true, needsRender: true };
} /* deleteSelectedShapes */

// Enterキーが押された時の処理 (頂点の割り込み追加)
function handleEnterAction() {
    if (state.insertVertexPending) {
        const pending = state.insertVertexPending;
        state.insertVertexPending = null;
        const targetShapeId = state.selectedShapeIds[0];
        if (targetShapeId && targetShapeId !== pending.shapeId) {
            insertVertex(pending.shapeId, pending.vertexIdx, targetShapeId);
            return { pushHistory: true, needsRender: true };
        }
    }
    return { pushHistory: false, needsRender: false };
}

function insertVertex(wrapShapeId, vertexIdx, targetShapeId) {
    const wrapShape = state.shapes[wrapShapeId];
    const targetShape = state.shapes[targetShapeId];
    if (!wrapShape || !targetShape || !targetShape.bezierIds || targetShape.bezierIds.length === 0) return;

    const N = wrapShape.bezierIds.length;
    const bezierIdx = Math.floor(vertexIdx / 2) % N;
    const bidAB = wrapShape.bezierIds[bezierIdx];
    const bezAB = state.beziers[bidAB];
    if (!bezAB) return;

    const bidAC = generateId('b');
    const bidCB = generateId('b');

    state.beziers[bidAC] = {
        id: bidAC,
        generator: {
            type: 'connector',
            params: {
                src1: { ...bezAB.generator.params.src1 },
                src2: { bezierId: targetShape.bezierIds[0], t: 0 },
                d1: bezAB.generator.params.d1,
                d2: 0.1
            }
        },
        controlPoints: [], samplePointByT: {}, boundingBox: {}
    };

    state.beziers[bidCB] = {
        id: bidCB,
        generator: {
            type: 'connector',
            params: {
                src1: { bezierId: targetShape.bezierIds[0], t: 0 },
                src2: { ...bezAB.generator.params.src2 },
                d1: 0.1,
                d2: bezAB.generator.params.d2
            }
        },
        controlPoints: [], samplePointByT: {}, boundingBox: {}
    };

    delete state.beziers[bidAB];
    wrapShape.bezierIds.splice(bezierIdx, 1, bidAC, bidCB);

    // 新たに挿入された頂点 (ACの終端) にフォーカス
    state.focusedVertex = {
        shapeId: wrapShapeId,
        vertexIdx: bezierIdx * 2 + 1
    };

    resolveBezierDependencies();
}

function deleteVertex(wrapShapeId, vertexIdx) {
    const shape = state.shapes[wrapShapeId];
    if (!shape || !shape.bezierIds || shape.bezierIds.length <= 3) return;

    const N = shape.bezierIds.length;
    const vIdx = Math.floor((vertexIdx + 1) / 2) % N;

    const idx1 = (vIdx - 1 + N) % N;
    const idx2 = vIdx;

    const bidDA = shape.bezierIds[idx1];
    const bidAE = shape.bezierIds[idx2];
    const bezDA = state.beziers[bidDA];
    const bezAE = state.beziers[bidAE];

    if (!bezDA || !bezAE) return;

    const bidDE = generateId('b');
    state.beziers[bidDE] = {
        id: bidDE,
        generator: {
            type: 'connector',
            params: {
                src1: { ...bezDA.generator.params.src1 },
                src2: { ...bezAE.generator.params.src2 },
                d1: bezDA.generator.params.d1,
                d2: bezAE.generator.params.d2
            }
        },
        controlPoints: [], samplePointByT: {}, boundingBox: {}
    };

    delete state.beziers[bidDA];
    delete state.beziers[bidAE];

    if (idx1 < idx2) {
        shape.bezierIds.splice(idx1, 2, bidDE);
    } else {
        shape.bezierIds.splice(idx2, 1);
        const newIdx1 = shape.bezierIds.indexOf(bidDA);
        shape.bezierIds.splice(newIdx1, 1, bidDE);
    }

    const newIdx = shape.bezierIds.indexOf(bidDE);
    state.focusedVertex = {
        shapeId: wrapShapeId,
        vertexIdx: newIdx * 2
    };

    resolveBezierDependencies();
}

/**
 * Bezier Math & Engine
 */
const bezierGeneratorMap = {
    arc: (params) => {
        const { x, y, r, startAngle, endAngle } = params;
        const p0 = { x: x + Math.cos(startAngle) * r, y: y + Math.sin(startAngle) * r };
        const p3 = { x: x + Math.cos(endAngle) * r, y: y + Math.sin(endAngle) * r };
        const p1 = {
            x: p0.x - Math.sin(startAngle) * r * KAPPA,
            y: p0.y + Math.cos(startAngle) * r * KAPPA
        };
        const p2 = {
            x: p3.x + Math.sin(endAngle) * r * KAPPA,
            y: p3.y - Math.cos(endAngle) * r * KAPPA
        };
        return [{ v: p0 }, { v: p1 }, { v: p2 }, { v: p3 }];
    },
    connector: (params) => {
        const { src1, src2, d1, d2 } = params;
        const bez1 = state.beziers[src1.bezierId];
        const bez2 = state.beziers[src2.bezierId];
        if (!bez1 || !bez2) return [];

        const p0 = getBezierPoint(bez1, src1.t);
        const p3 = getBezierPoint(bez2, src2.t);
        const tan1 = getBezierTangent(bez1, src1.t);
        const tan2 = getBezierTangent(bez2, src2.t);

        const p1 = { x: p0.x + tan1.dx * d1, y: p0.y + tan1.dy * d1 };
        const p2 = { x: p3.x - tan2.dx * d2, y: p3.y - tan2.dy * d2 };

        return [{ v: p0 }, { v: p1 }, { v: p2 }, { v: p3 }];
    },
}; /* bezierGeneratorMap */

function getBezierPoint(bez, t) {
    if (!bez) return { x: 0, y: 0 };
    const p = bez.controlPoints.map(cp => cp.v);
    if (p.length < 4 || p.some(cp => !cp || cp.x === undefined)) {
        // console.warn(`Invalid control points for bezier ${bez.id}`);
        return { x: 0, y: 0 };
    }
    const mt = 1 - t;
    return {
        x: mt ** 3 * (p[0].x || 0) + 3 * mt ** 2 * t * (p[1].x || 0) + 3 * mt * t ** 2 * (p[2].x || 0) + t ** 3 * (p[3].x || 0),
        y: mt ** 3 * (p[0].y || 0) + 3 * mt ** 2 * t * (p[1].y || 0) + 3 * mt * t ** 2 * (p[2].y || 0) + t ** 3 * (p[3].y || 0)
    };
} /* getBezierPoint */

function getBezierTangent(bez, t) {
    if (!bez) return { dx: 0, dy: 0 };
    const p = bez.controlPoints.map(cp => cp.v);
    const mt = 1 - t;
    const dx = 3 * mt ** 2 * ((p[1].x || 0) - (p[0].x || 0)) + 6 * mt * t * ((p[2].x || 0) - (p[1].x || 0)) + 3 * t ** 2 * ((p[3].x || 0) - (p[2].x || 0));
    const dy = 3 * mt ** 2 * ((p[1].y || 0) - (p[0].y || 0)) + 6 * mt * t * ((p[2].y || 0) - (p[1].y || 0)) + 3 * t ** 2 * ((p[3].y || 0) - (p[2].y || 0));
    return { dx, dy };
} /* getBezierTangent */

function updateBezier(id) {
    const bez = state.beziers[id];
    if (!bez || !bez.generator) return;

    const generatorFunc = bezierGeneratorMap[bez.generator.type];
    if (generatorFunc) {
        bez.controlPoints = generatorFunc(bez.generator.params);
    }

    if (!bez.controlPoints || bez.controlPoints.length < 4) return;

    bez.samplePointByT = {};
    const sample = (t1, t2) => {
        const p1 = getBezierPoint(bez, t1), p2 = getBezierPoint(bez, t2);
        if (Math.hypot(p1.x - p2.x, p1.y - p2.y) > state.lodPrecision) {
            const mid = (t1 + t2) / 2;
            sample(t1, mid);
            sample(mid, t2);
        } else {
            bez.samplePointByT[t2] = p2;
        }
    }; /* sample */
    bez.samplePointByT[0] = getBezierPoint(bez, 0);
    sample(0, 1);

    // 4. Update Bounding Box
    const pts = Object.values(bez.samplePointByT);
    const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
    bez.boundingBox = {
        x: Math.min(...xs), y: Math.min(...ys),
        w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys)
    };
} /* updateBezier */

function resolveBezierDependencies() {
    // 1. すべての wrap Shape について、隣接するベジェの共有端点 (src1 と src2) を同期する (Option A)
    Object.values(state.shapes).forEach(shape => {
        if (shape && shape.name && shape.name.startsWith('wrap') && shape.bezierIds && shape.bezierIds.length > 0) {
            const N = shape.bezierIds.length;
            for (let i = 0; i < N; i++) {
                const bid1 = shape.bezierIds[(i - 1 + N) % N];
                const bid2 = shape.bezierIds[i];
                const bez1 = state.beziers[bid1];
                const bez2 = state.beziers[bid2];
                if (bez1 && bez2 && bez1.generator && bez2.generator && bez1.generator.params && bez2.generator.params) {
                    const param1 = bez1.generator.params.src2;
                    const param2 = bez2.generator.params.src1;
                    if (param1 && param2) {
                        // param2 (src1) を代表の正として param1 (src2) を同期する
                        if (param1.bezierId !== param2.bezierId || param1.t !== param2.t) {
                            param1.bezierId = param2.bezierId;
                            param1.t = param2.t;
                        }
                    }
                }
            }
        }
    });

    const visited = new Set(), visiting = new Set(), sorted = [];
    const visit = (id) => {
        if (visited.has(id)) return;
        if (visiting.has(id)) return; // 循環参照の切断
        visiting.add(id);
        const b = state.beziers[id];
        if (!b) return;
        if (b.generator && b.generator.params) {
            const { src1, src2 } = b.generator.params;
            if (src1 && src1.bezierId) visit(src1.bezierId);
            if (src2 && src2.bezierId) visit(src2.bezierId);
        }
        visiting.delete(id);
        visited.add(id); sorted.push(id);
    };
    Object.keys(state.beziers).forEach(visit);
    sorted.forEach(updateBezier);
} /* resolveBezierDependencies */

function moveShape(id, dx, dy) {
    const shape = state.shapes[id];
    if (shape && shape.bezierIds) shape.bezierIds.forEach(bid => {
        const bez = state.beziers[bid];
        if (bez && bez.generator && bez.generator.type === 'arc') {
            bez.generator.params.x += dx; bez.generator.params.y += dy;
        }
    }); /* shape.bezierIds.forEach */
    resolveBezierDependencies();
} /* moveShape */

function scaleShape(id, factor) {
    const shape = state.shapes[id];
    if (shape && shape.bezierIds) shape.bezierIds.forEach(bid => {
        const bez = state.beziers[bid];
        if (bez && bez.generator && bez.generator.type === 'arc') {
            bez.generator.params.r *= factor;
        }
    });
    resolveBezierDependencies();
} /* scaleShape */

function rotateShape(id, angle) {
    const shape = state.shapes[id];
    if (shape && shape.bezierIds) shape.bezierIds.forEach(bid => {
        const bez = state.beziers[bid];
        if (bez && bez.generator && bez.generator.type === 'arc') {
            const rad = angle * Math.PI / 180;
            bez.generator.params.startAngle += rad;
            bez.generator.params.endAngle += rad;
        }
    });
    resolveBezierDependencies();
} /* rotateShape */

function addShapeAt(type, x, y) {
    const id = generateId('s');
    const bIds = [], r = 50;
    if (type === 'circle') {
        for (let i = 0; i < 4; i++) {
            const bId = generateId('b'), a = (i * Math.PI) / 2, na = ((i + 1) * Math.PI) / 2;
            state.beziers[bId] = {
                id: bId,
                generator: {
                    type: 'arc',
                    params: { x, y, r, startAngle: a, endAngle: na }
                },
                controlPoints: [], samplePointByT: {}, boundingBox: {}
            };
            bIds.push(bId);
        }
    }
    const count = Object.values(state.shapes).filter(s => s.name && s.name.startsWith(type)).length + 1;
    const shape = {
        id, type: 'bezier-group', name: `${type} ${count}`, bezierIds: bIds, props: { x, y },
        style: { fill: '#2196F3', opacity: 0.7 }, childIds: []
    };
    state.shapes[id] = shape;

    // アクティブレイヤーに追加
    if (state.selectedLayerId && state.shapes[state.selectedLayerId]) {
        state.shapes[state.selectedLayerId].childIds.push(id);
    } else {
        const firstLayerId = state.scene[0];
        if (firstLayerId && state.shapes[firstLayerId]) {
            state.shapes[firstLayerId].childIds.push(id);
        }
    }

    resolveBezierDependencies();
    pushHistory();
    renderCanvas();
} /* addShapeAt */

function createWrap() {
    // 【保留事項】
    // 将来的に 3 つ以上の複数図形の Wrap や、すでに Wrap された図形同士をさらに Wrap する階層化への対応を見据えています。
    // 現状は 2 つの図形選択に固定したロジックとなっていますが、次のステップにて 3 点以上の Wrap 生成や、
    // 生成後の頂点（ベジェ本数）の増減編集機能の設計・実装を行う予定のため、ここは一旦修正を保留とします。
    const targets = Array.from(new Set([...state.anchoredShapeIds, ...state.selectedShapeIds]));
    if (targets.length < 2) {
        return;
    }
    const [id1, id2] = targets;
    const shape1 = state.shapes[id1], shape2 = state.shapes[id2];
    if (!shape1 || !shape2) return;

    // 接続元の図形から接続点のベジェIDを選定する
    // 【接続点選定に関する設計方針】
    // 円同士に限らず様々な図形（すでにwrapされた図形など）に対応するため、ここでは幾何学的な接線計算は行わず、
    // 接続対象の図形の bezierIds[0] の t=0 (上側) と bezierIds[Math.min(2, bezierIds.length-1)] の t=0 (下側) を
    // 固定的に結ぶシンプルなロジックとします。
    // ※ 左右に並んだ円以外のケースでは、初期生成時の形状が「パッと見でwrapっぽくない交差した形」に見える場合がありますが、
    //   後からユーザーがスライド操作等で手動微調整することを前提とする（Hello Neighbor的アプローチ）ため、これを許容します。
    const src1_up_bezier = shape1.bezierIds[0];
    const src1_down_bezier = shape1.bezierIds[Math.min(2, shape1.bezierIds.length - 1)];
    const src2_up_bezier = shape2.bezierIds[0];
    const src2_down_bezier = shape2.bezierIds[Math.min(2, shape2.bezierIds.length - 1)];

    const wrapId = generateId('s');
    const bIds = [];

    // 4本の接続ベジェを生成（時計回りの環状ループになるように順次接続）
    // 1. 上側接続線: shape1_up -> shape2_up
    const bId1 = generateId('b');
    state.beziers[bId1] = {
        id: bId1,
        generator: {
            type: 'connector',
            params: {
                src1: { bezierId: src1_up_bezier, t: 0 },
                src2: { bezierId: src2_up_bezier, t: 0 },
                d1: 0.1, d2: 0.1
            }
        },
        controlPoints: [], samplePointByT: {}, boundingBox: {}
    };
    bIds.push(bId1);

    // 2. 右側代替線: shape2_up -> shape2_down (shape2の側面に重なる線)
    const bId2 = generateId('b');
    state.beziers[bId2] = {
        id: bId2,
        generator: {
            type: 'connector',
            params: {
                src1: { bezierId: src2_up_bezier, t: 0 },
                src2: { bezierId: src2_down_bezier, t: 0 },
                d1: 0.1, d2: 0.1
            }
        },
        controlPoints: [], samplePointByT: {}, boundingBox: {}
    };
    bIds.push(bId2);

    // 3. 下側接続線: shape2_down -> shape1_down
    const bId3 = generateId('b');
    state.beziers[bId3] = {
        id: bId3,
        generator: {
            type: 'connector',
            params: {
                src1: { bezierId: src2_down_bezier, t: 0 },
                src2: { bezierId: src1_down_bezier, t: 0 },
                d1: 0.1, d2: 0.1
            }
        },
        controlPoints: [], samplePointByT: {}, boundingBox: {}
    };
    bIds.push(bId3);

    // 4. 左側代替線: shape1_down -> shape1_up (shape1の側面に重なる線)
    const bId4 = generateId('b');
    state.beziers[bId4] = {
        id: bId4,
        generator: {
            type: 'connector',
            params: {
                src1: { bezierId: src1_down_bezier, t: 0 },
                src2: { bezierId: src1_up_bezier, t: 0 },
                d1: 0.1, d2: 0.1
            }
        },
        controlPoints: [], samplePointByT: {}, boundingBox: {}
    };
    bIds.push(bId4);

    // 新しい wrap Shape オブジェクトを作成
    const wrapCount = Object.values(state.shapes).filter(s => s.name && s.name.startsWith('wrap')).length + 1;
    const wrapShape = {
        id: wrapId,
        type: 'bezier-group',
        name: `wrap ${wrapCount}`,
        bezierIds: bIds,
        props: { x: 0, y: 0 },
        style: { fill: '#2196F3', opacity: 0.5 }, // 半透明の青で塗りつぶす
        childIds: []
    };
    state.shapes[wrapId] = wrapShape;

    // アクティブレイヤーに追加
    if (state.selectedLayerId && state.shapes[state.selectedLayerId]) {
        state.shapes[state.selectedLayerId].childIds.push(wrapId);
    } else {
        const firstLayerId = state.scene[0];
        if (firstLayerId && state.shapes[firstLayerId]) {
            state.shapes[firstLayerId].childIds.push(wrapId);
        }
    }

    resolveBezierDependencies();
    pushHistory();
    renderCanvas();
} /* createWrap */

function renderCanvas() {
    const svg = document.getElementById('main-svg');
    svg.innerHTML = `<defs id="main-defs"></defs><g id="viewport" transform="translate(${state.pan.x}, ${state.pan.y}) scale(${state.zoom}) rotate(${state.rotation})"></g>`;
    const viewport = svg.getElementById('viewport');
    const defs = svg.getElementById('main-defs');

    // activeLayerId に属するShapeのみをメインのSVGに描画
    const activeLayerId = state.selectedLayerId;
    if (activeLayerId) {
        renderShape(activeLayerId, viewport, defs);
    }

    // under-canvas / over-canvas にそれぞれオフスクリーンから転写
    const underCanvas = document.getElementById('under-canvas');
    const overCanvas = document.getElementById('over-canvas');
    if (underCanvas && state.canvas.underOffscreen) {
        drawOffscreenToOnscreen(underCanvas, state.canvas.underOffscreen);
    }
    if (overCanvas && state.canvas.overOffscreen) {
        drawOffscreenToOnscreen(overCanvas, state.canvas.overOffscreen);
    }

    renderMinimap();
    renderLayerList();
} /* renderCanvas */

function drawOffscreenToOnscreen(onscreen, offscreen) {
    const ctx = onscreen.getContext('2d');
    const rect = onscreen.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;

    if (onscreen.width !== Math.floor(rect.width * dpr) || onscreen.height !== Math.floor(rect.height * dpr)) {
        onscreen.width = Math.floor(rect.width * dpr);
        onscreen.height = Math.floor(rect.height * dpr);
    }

    ctx.clearRect(0, 0, onscreen.width, onscreen.height);
    ctx.save();
    ctx.scale(dpr, dpr);

    // SVG viewport の scale/rotate/pan と同期
    ctx.translate(state.pan.x, state.pan.y);
    ctx.scale(state.zoom, state.zoom);
    ctx.rotate(state.rotation * Math.PI / 180);

    ctx.drawImage(offscreen, 0, 0);
    ctx.restore();
}

function drawShapeToCanvasContext(ctx, shapeId) {
    const shape = state.shapes[shapeId];
    if (!shape) return;

    if (shape.type === 'layer' && shape.visible === false) return;

    ctx.save();

    if (shape.type === 'layer') {
        ctx.globalAlpha *= (shape.style?.opacity ?? 1);
        shape.childIds?.forEach(childId => drawShapeToCanvasContext(ctx, childId));
    } else if (shape.type === 'linked-paste' && shape.sourceId) {
        const src = state.shapes[shape.sourceId];
        if (src) {
            for (let i = 0; i < (shape.transform.count || 0); i++) {
                const angle = i * (shape.transform.rotationStep || 0);
                ctx.save();
                ctx.rotate(angle * Math.PI / 180);
                if (shape.transform.mirror) {
                    ctx.scale(-1, 1);
                }
                drawShapeToCanvasContext(ctx, src.id);
                ctx.restore();
            }
        }
    } else if (shape.bezierIds) {
        ctx.beginPath();
        let first = true;
        shape.bezierIds.forEach((bid, i) => {
            const b = state.beziers[bid];
            if (!b || !b.controlPoints || b.controlPoints.length < 4) return;
            const v = b.controlPoints.map(cp => cp.v);
            if (first) {
                ctx.moveTo(v[0].x, v[0].y);
                first = false;
            } else {
                ctx.lineTo(v[0].x, v[0].y);
            }
            ctx.bezierCurveTo(v[1].x, v[1].y, v[2].x, v[2].y, v[3].x, v[3].y);
        });
        if (shape.name && shape.name.startsWith('wrap')) {
            ctx.closePath();
        }

        ctx.fillStyle = shape.style?.fill || '#000000';
        ctx.globalAlpha = shape.style?.opacity ?? 1;
        ctx.fill();

        ctx.strokeStyle = shape.style?.fill || '#000000';
        ctx.lineWidth = 1;
        ctx.stroke();
    }

    ctx.restore();
}

function rasterizeInactiveLayers() {
    if (!state.canvas.underOffscreen || !state.canvas.overOffscreen || !state.canvas.activeOffscreen) return;

    const underCtx = state.canvas.underOffscreen.getContext('2d');
    const overCtx = state.canvas.overOffscreen.getContext('2d');
    const activeCtx = state.canvas.activeOffscreen.getContext('2d');

    underCtx.clearRect(0, 0, state.canvas.width, state.canvas.height);
    overCtx.clearRect(0, 0, state.canvas.width, state.canvas.height);
    activeCtx.clearRect(0, 0, state.canvas.width, state.canvas.height);

    let foundActive = false;

    state.scene.forEach(layerId => {
        const layer = state.shapes[layerId];
        if (!layer) return;

        if (layerId === state.selectedLayerId) {
            foundActive = true;
            drawShapeToCanvasContext(activeCtx, layerId);
        } else {
            const targetCtx = foundActive ? overCtx : underCtx;
            drawShapeToCanvasContext(targetCtx, layerId);
        }
    });
}

function renderMinimap() {
    const canvas = document.getElementById('minimap-canvas');
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    const rect = canvas.getBoundingClientRect();
    if (canvas.width !== rect.width || canvas.height !== rect.height) {
        canvas.width = rect.width;
        canvas.height = rect.height;
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // アクティブレイヤーを一時的に activeOffscreen にラスタライズ
    const activeLayerId = state.selectedLayerId;
    if (activeLayerId && state.canvas.activeOffscreen) {
        const activeCtx = state.canvas.activeOffscreen.getContext('2d');
        activeCtx.clearRect(0, 0, state.canvas.width, state.canvas.height);
        drawShapeToCanvasContext(activeCtx, activeLayerId);
    }

    // キャンバス全体がミニマップにフィットする基本スケールを算出
    const baseScale = Math.min(canvas.width / state.canvas.width, canvas.height / state.canvas.height);
    const zoomScale = baseScale * state.minimap.zoom;

    ctx.save();
    // ミニマップキャンバスの中心を基準にズームを適用
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.scale(zoomScale, zoomScale);
    ctx.translate(-state.canvas.width / 2, -state.canvas.height / 2);

    // 各オフスクリーンを重ねて転写
    if (state.canvas.underOffscreen) ctx.drawImage(state.canvas.underOffscreen, 0, 0);
    if (state.canvas.activeOffscreen) ctx.drawImage(state.canvas.activeOffscreen, 0, 0);
    if (state.canvas.overOffscreen) ctx.drawImage(state.canvas.overOffscreen, 0, 0);

    ctx.restore();
}

function renderShape(id, container, defs, isMinimap = false) {
    const shape = state.shapes[id];
    if (!shape) return;

    // レイヤー非表示時のスキップ
    if (shape.type === 'layer' && shape.visible === false) return;

    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');

    if (shape.type === 'layer') {
        g.setAttribute('opacity', shape.style?.opacity ?? 1);
        shape.childIds.forEach(childId => renderShape(childId, g, defs, isMinimap));
    } else if (shape.type === 'linked-paste' && shape.sourceId) {
        const src = state.shapes[shape.sourceId];
        if (src) for (let i = 0; i < (shape.transform.count || 0); i++) {
            const cloneG = document.createElementNS('http://www.w3.org/2000/svg', 'g'), angle = i * (shape.transform.rotationStep || 0), mirror = shape.transform.mirror ? 'scale(-1, 1)' : '';
            cloneG.setAttribute('transform', `rotate(${angle}) ${mirror}`);
            renderShape(src.id, cloneG, defs, isMinimap); g.appendChild(cloneG);
        }
    } else if (shape.bezierIds) {
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        let d = '';
        shape.bezierIds.forEach((bid, i) => {
            const b = state.beziers[bid];
            if (!b || !b.controlPoints || b.controlPoints.length < 4) return;
            const v = b.controlPoints.map(cp => cp.v);

            if (i === 0) {
                d += `M ${v[0].x},${v[0].y}`;
            }
            d += ` C ${v[1].x},${v[1].y} ${v[2].x},${v[2].y} ${v[3].x},${v[3].y}`;
        }); /* bezierIds.forEach */
        if (shape.name && shape.name.startsWith('wrap')) {
            d += ' Z';
        }
        path.setAttribute('d', d);
        path.setAttribute('fill', shape.style.fill);
        path.setAttribute('fill-opacity', shape.style.opacity);

        const isSelected = !isMinimap && state.selectedShapeIds.includes(shape.id);
        const isAnchored = !isMinimap && state.anchoredShapeIds?.includes(shape.id);
        let strokeColor = shape.style.fill;
        let strokeWidth = 1;
        if (isSelected) {
            strokeColor = '#ffeb3b'; // 黄色
            strokeWidth = 3;
        } else if (isAnchored) {
            strokeColor = '#ff9800'; // オレンジ
            strokeWidth = 3;
        }
        path.setAttribute('stroke', strokeColor);
        path.setAttribute('stroke-width', strokeWidth);
        g.appendChild(path);

        // 頂点選択モード（キーボード駆動のフォーカス調整中）の UI 表示
        if (!isMinimap && state.focusedVertex && state.focusedVertex.shapeId === shape.id) {
            const { vertexIdx } = state.focusedVertex;
            if (shape.bezierIds && shape.bezierIds.length > 0) {
                const bezierIdx = Math.floor(vertexIdx / 2) % shape.bezierIds.length;
                const bid = shape.bezierIds[bezierIdx];
                const b = state.beziers[bid];
                if (b && b.controlPoints && b.controlPoints.length >= 4) {
                    const isStart = (vertexIdx % 2 === 0);
                    const vertexPt = b.controlPoints[isStart ? 0 : 3].v;
                    const cpPt = b.controlPoints[isStart ? 1 : 2].v;

                    // 1. 調整中の制御線（点線：オレンジ）
                    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
                    line.setAttribute('x1', vertexPt.x); line.setAttribute('y1', vertexPt.y);
                    line.setAttribute('x2', cpPt.x); line.setAttribute('y2', cpPt.y);
                    line.setAttribute('stroke', '#ff9800'); line.setAttribute('stroke-dasharray', '2,2');
                    line.setAttribute('stroke-width', 1.5);
                    g.appendChild(line);

                    // 2. 調整中の制御点（小円：オレンジ枠・白塗り）
                    const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
                    c.setAttribute('cx', cpPt.x); c.setAttribute('cy', cpPt.y); c.setAttribute('r', 4);
                    c.setAttribute('fill', 'white'); c.setAttribute('stroke', '#ff9800');
                    c.setAttribute('stroke-width', 1.5);
                    g.appendChild(c);

                    // 3. 調整中の頂点（強調表示：オレンジ色の二重円）
                    const cOuter = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
                    cOuter.setAttribute('cx', vertexPt.x); cOuter.setAttribute('cy', vertexPt.y); cOuter.setAttribute('r', 8);
                    cOuter.setAttribute('fill', 'none'); cOuter.setAttribute('stroke', '#ff9800'); cOuter.setAttribute('stroke-width', 1.5);
                    g.appendChild(cOuter);

                    const cInner = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
                    cInner.setAttribute('cx', vertexPt.x); cInner.setAttribute('cy', vertexPt.y); cInner.setAttribute('r', 4);
                    cInner.setAttribute('fill', '#ff9800');
                    g.appendChild(cInner);
                }
            }
        }
    } /* shape.bezierIds */
    container.appendChild(g);
} /* renderShape */

function getSVGPoint(e, element) {
    const svg = document.getElementById('main-svg');
    const el = element || svg;
    const p = svg.createSVGPoint();
    p.x = e.clientX;
    p.y = e.clientY;
    return p.matrixTransform(el.getScreenCTM().inverse());
} /* getSVGPoint */

function initDB() {
    const request = indexedDB.open('morph-draw-db', 1);
    request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('drawings')) {
            db.createObjectStore('drawings', { keyPath: 'id' });
        }
    }; /* onupgradeneeded */
    request.onsuccess = (e) => { db = e.target.result; loadGallery(); };
} /* initDB */

function switchView(viewId) {
    state.view = viewId;
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById(`view-${viewId}`).classList.add('active');
} /* switchView */

async function saveDrawing() {
    if (!state.currentDrawId || !db) return;
    const svgEl = document.getElementById('main-svg');
    const serializer = new XMLSerializer();
    const svgString = serializer.serializeToString(svgEl);
    const preview = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgString)));

    const tx = db.transaction('drawings', 'readwrite');
    const store = tx.objectStore('drawings');
    const cleaned = JSON.parse(JSON.stringify({
        shapes: state.shapes,
        beziers: state.beziers,
        scene: state.scene
    }, stateReplacer));

    await store.put({
        id: state.currentDrawId,
        shapes: cleaned.shapes,
        beziers: cleaned.beziers,
        scene: cleaned.scene,
        preview: preview,
        updatedAt: Date.now()
    });
} /* saveDrawing */

function loadGallery() {
    if (!db) return;
    const tx = db.transaction('drawings', 'readonly');
    const store = tx.objectStore('drawings');
    const request = store.getAll();
    request.onsuccess = () => renderGalleryGrid(request.result);
} /* loadGallery */

function renderGalleryGrid(items) {
    const list = document.getElementById('gallery-list');
    list.innerHTML = '';
    items.sort((a, b) => b.updatedAt - a.updatedAt).forEach(item => {
        const card = document.createElement('div');
        card.className = 'gallery-card';
        card.innerHTML = `
            <div class="card-preview">
                ${item.preview ? `<img src="${item.preview}" alt="preview">` : ''}
            </div>
            <div class="card-info">
                <span>Drawing ${item.id.slice(-4)}</span>
                <button class="btn-card-delete" data-id="${item.id}"><i class="bi bi-trash"></i></button>
            </div>
        `; /* card.innerHTML */
        card.onclick = () => openDrawing(item.id);
        card.querySelector('.btn-card-delete').onclick = (e) => deleteDrawing(item.id, e);
        list.appendChild(card);
    }); /* items.forEach */
} /* renderGalleryGrid */

async function deleteDrawing(id, e) {
    e.stopPropagation();
    if (!confirm('このお絵かきを削除しますか？')) return;
    const tx = db.transaction('drawings', 'readwrite');
    const store = tx.objectStore('drawings');
    await store.delete(id);
    loadGallery();
} /* deleteDrawing */

function openDrawing(id) {
    const tx = db.transaction('drawings', 'readonly');
    const store = tx.objectStore('drawings');
    const request = store.get(id);
    request.onsuccess = () => {
        const data = request.result;
        state.currentDrawId = data.id;
        state.shapes = data.shapes || {};
        state.beziers = data.beziers || {};
        state.scene = data.scene || [];

        // IDカウンタの初期化
        initializeIdCounter();

        // マイグレーション: レイヤーが無い場合は、既存のShapeをすべて含むデフォルトレイヤーを自動生成
        const hasLayers = state.scene.some(sid => state.shapes[sid]?.type === 'layer');
        if (!hasLayers) {
            const newLayerId = generateId('l');
            const oldScene = [...state.scene];
            state.shapes[newLayerId] = {
                id: newLayerId,
                type: 'layer',
                name: 'Layer 1',
                childIds: oldScene,
                style: { opacity: 1 },
                visible: true,
                locked: false
            };
            state.scene = [newLayerId];
        }

        // アクティブなレイヤーを設定
        state.selectedLayerId = state.scene[0];

        // 依存関係とキャッシュデータの再計算
        resolveBezierDependencies();

        rasterizeInactiveLayers();
        renderCanvas();
        pushHistory();
        switchView('canvas');
    }; /* onsuccess */
} /* openDrawing */

async function startNewDrawing() {
    let nextId = 'd1';
    if (db) {
        try {
            const drawings = await new Promise((resolve, reject) => {
                const tx = db.transaction('drawings', 'readonly');
                const store = tx.objectStore('drawings');
                const req = store.getAll();
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            });
            let max = 0;
            for (const d of drawings) {
                if (d.id && d.id.startsWith('d')) {
                    const num = parseInt(d.id.substring(1), 10);
                    if (!isNaN(num) && num > max) max = num;
                }
            }
            nextId = `d${max + 1}`;
        } catch (e) {
            console.error(e);
        }
    }
    state.currentDrawId = nextId;
    state.shapes = {};
    state.beziers = {};
    state.scene = [];
    state.selectedShapeIds = [];
    state.anchoredShapeIds = [];
    state.zoom = 1;
    state.rotation = 0;
    state.pan = { x: 0, y: 0 };
    state.history = [];
    state.historyIndex = -1;
    state.nextIdCounter = 1;

    // デフォルトレイヤーの作成
    const layerId = generateId('l');
    state.shapes[layerId] = {
        id: layerId,
        type: 'layer',
        name: 'Layer 1',
        childIds: [],
        style: { opacity: 1 },
        visible: true,
        locked: false
    };
    state.scene = [layerId];
    state.selectedLayerId = layerId;

    rasterizeInactiveLayers();
    renderCanvas();
    pushHistory();
    switchView('canvas');
} /* startNewDrawing */

function addLayer() {
    const id = generateId('l');
    const count = state.scene.filter(sid => state.shapes[sid]?.type === 'layer').length + 1;
    state.shapes[id] = {
        id,
        type: 'layer',
        name: `Layer ${count}`,
        childIds: [],
        style: { opacity: 1 },
        visible: true,
        locked: false
    };
    state.scene.push(id);
    state.selectedLayerId = id;
    rasterizeInactiveLayers();
    renderCanvas();
    pushHistory();
} /* addLayer */

function deleteLayer(layerId) {
    const layer = state.shapes[layerId];
    if (!layer || layer.type !== 'layer') return;

    const layerCount = state.scene.filter(sid => state.shapes[sid]?.type === 'layer').length;
    if (layerCount <= 1) {
        return;
    }

    if (!confirm(`レイヤー「${layer.name}」と内包するすべての図形を削除しますか？`)) return;

    // レイヤー内の子Shapeを削除
    layer.childIds.forEach(shapeId => {
        const shape = state.shapes[shapeId];
        if (shape) {
            shape.bezierIds?.forEach(bid => delete state.beziers[bid]);
            delete state.shapes[shapeId];
        }
    });

    // レイヤー自身を削除
    delete state.shapes[layerId];
    state.scene = state.scene.filter(id => id !== layerId);

    // 選択レイヤーの更新
    if (state.selectedLayerId === layerId) {
        state.selectedLayerId = state.scene[state.scene.length - 1];
    }

    rasterizeInactiveLayers();
    renderCanvas();
    pushHistory();
} /* deleteLayer */

function renderLayerList() {
    const list = document.getElementById('layer-list');
    if (!list) return;
    list.innerHTML = '';

    [...state.scene].reverse().forEach(layerId => {
        const layer = state.shapes[layerId];
        if (!layer || layer.type !== 'layer') return;

        const item = document.createElement('div');
        item.className = `layer-item${state.selectedLayerId === layerId ? ' active' : ''}${layer.visible ? '' : ' hidden-layer'}`;

        item.innerHTML = `
            <div class="layer-info">
                <span class="layer-visibility-btn"><i class="bi ${layer.visible ? 'bi-eye' : 'bi-eye-slash'}"></i></span>
                <input class="layer-name-input" type="text" value="${layer.name}">
            </div>
            <div class="layer-controls">
                <button class="layer-control-btn btn-layer-delete"><i class="bi bi-trash"></i></button>
            </div>
        `; /* item.innerHTML */

        // 選択イベント
        item.onclick = (e) => {
            if (e.target.closest('input') || e.target.closest('button') || e.target.closest('.layer-visibility-btn')) return;
            state.selectedLayerId = layerId;
            state.selectedShapeIds = []; // レイヤー切替時に図形選択をクリア
            state.focusedVertex = null;  // 頂点フォーカスもクリア
            rasterizeInactiveLayers();
            renderCanvas();
        };

        // 表示・非表示トグル
        item.querySelector('.layer-visibility-btn').onclick = (e) => {
            e.stopPropagation();
            layer.visible = !layer.visible;
            rasterizeInactiveLayers();
            renderCanvas();
            pushHistory();
        };

        // 名前編集
        const input = item.querySelector('.layer-name-input');
        input.onblur = () => {
            if (input.value.trim() !== '') {
                layer.name = input.value.trim();
                pushHistory();
            } else {
                input.value = layer.name;
            }
        };
        input.onkeydown = (e) => {
            if (e.key === 'Enter') input.blur();
        };

        // 削除
        item.querySelector('.btn-layer-delete').onclick = (e) => {
            e.stopPropagation();
            deleteLayer(layerId);
        };

        list.appendChild(item);
    });
} /* renderLayerList */

function openSearchMode() {
    state.search.active = true;
    const bar = document.getElementById('search-bar');
    if (!bar) return;
    bar.classList.remove('hidden');
    const input = document.getElementById('search-input');
    input.value = '';
    input.focus();
    state.search.results = [];
    state.search.currentIndex = -1;
}

function closeSearchMode(confirm = true) {
    state.search.active = false;
    const bar = document.getElementById('search-bar');
    if (bar) bar.classList.add('hidden');

    const input = document.getElementById('search-input');
    if (input) input.blur();
}

function performSearch(query) {
    const q = query.toLowerCase().trim();
    if (!q) {
        state.search.results = [];
        state.search.currentIndex = -1;
        return;
    }

    const results = [];

    // レイヤーをスキャン
    state.scene.forEach(layerId => {
        const layer = state.shapes[layerId];
        if (!layer || layer.type !== 'layer') return;

        // レイヤー自体のマッチ (name)
        if (layer.name.toLowerCase().includes(q)) {
            results.push({
                type: 'layer',
                id: layerId,
                name: layer.name,
                dispName: `レイヤー: ${layer.name}`
            });
        }

        // レイヤー内の子Shapeをスキャン
        layer.childIds.forEach(shapeId => {
            const shape = state.shapes[shapeId];
            if (!shape) return;

            let matches = false;
            let shapeName = shape.name || shape.type;

            // IDやtype、nameでのマッチ
            if (shape.id.toLowerCase().includes(q) ||
                shape.type.toLowerCase().includes(q) ||
                (shape.name && shape.name.toLowerCase().includes(q))) {
                matches = true;
            }

            // ベジェ曲線のジェネレータタイプでのマッチ
            if (shape.bezierIds) {
                const generators = shape.bezierIds.map(bid => state.beziers[bid]?.generator?.type).filter(Boolean);
                if (generators.some(g => g.toLowerCase().includes(q))) {
                    matches = true;
                }
            }

            if (matches) {
                results.push({
                    type: 'shape',
                    id: shapeId,
                    layerId: layerId,
                    name: shapeName,
                    dispName: `図形 (${shapeName}): ${shapeId.substring(0, 8)}`
                });
            }
        });
    });

    state.search.results = results;
    if (results.length > 0) {
        state.search.currentIndex = 0;
    } else {
        state.search.currentIndex = -1;
    }
}

function applySearchResult() {
    const results = state.search.results;
    const index = state.search.currentIndex;
    if (index < 0 || index >= results.length) return;

    state.focusedVertex = null; // 検索による図形選択変更時に頂点フォーカスをクリア
    const current = results[index];
    if (current.type === 'layer') {
        state.selectedLayerId = current.id;
        state.selectedShapeIds = []; // レイヤー選択時は図形選択をクリア
    } else if (current.type === 'shape') {
        state.selectedLayerId = current.layerId; // 図形を含むレイヤーをアクティブに
        state.selectedShapeIds = [current.id];   // 図形を選択
    }
    renderCanvas();
}

/* EOF */
