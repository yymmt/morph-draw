/**
 * @file state.js
 * @description Holds the application global state, configuration maps, and basic UI/math utility helpers.
 */

/**
 * Global state object containing the application mode, canvas specifications, loaded drawings, and interaction input trackers.
 * @type {Object}
 */
const state = {
    view: 'gallery',
    currentDrawId: null,
    drawingType: 'canvas', // 'canvas' | 'pattern' | 'import_image'
    shapes: {} as any, // ID -> Shape
    beziers: {} as any,  // ID -> Bezier
    scene: [],    // Root level IDs
    zoom: 1,
    rotation: 0,
    pan: { x: 0, y: 0 },
    history: [],
    historyIndex: -1,
    pushHistoryOnKeyUp: false, // Key release history save flag
    selectedShapeIds: [],
    anchoredShapeIds: [], // Anchored shape IDs (highlighted in orange)
    focusedVertex: null,   // Currently focused bezier endpoint: { shapeId, vertexIdx }
    thicknessEdit: {
        active: false,
        targetT: 0.0,
        editIndex: -1
    },
    dragInfo: null, // { type: 'move'|'pan'|'key-hold'|'drag', ... }
    interaction: {
        mode: null,
        activeKeys: new Set(),
    },
    lastHit: null,
    lodPrecision: 10, // 10px in editing, 1px on commit
    selectedLayerId: null, // Currently active layer ID
    maxDrawingId: 0, // Cache for maximum drawing ID
    drawingName: '', // Name of the active drawing
    search: {
        active: false,
        results: [],
        currentIndex: -1
    },
    patternEdit: {
        active: false,
        selectedCorner: 'TL',
        targetT: 0.0
    },
    command: {
        active: false
    },
    draftStrokes: [],
    currentDraftStroke: null,
    deformStartPoints: null,
    deformSettings: {
        sigmaCenter: 120,
        sigmaDist: 1000,
        deformDecayMode: 'projection'
    },
    nextIdCounter: 1,
    patternWebGLCanvas: null,
    input: {
        keys: {},
        pointerOnSVG: { x: 0, y: 0 },
        dragStartOnSVG: null,
        dragStart: null,
        pointer: { x: 0, y: 0 },
        dPointer: { x: 0, y: 0 },
        deltaY: 0,
        modifier: 'no_mod', // '', 'ctrl', 'shift', 'ctrl_shift'
        lock: false,
        isPointerDown: false,
        hoverOn: '',
    },
    minimap: {
        zoom: 1.0
    },
    webglTextures: {},
    canvas: {
        width: 2000,
        height: 2000,
        underOffscreen: null,
        activeOffscreen: null,
        overOffscreen: null,
        draftOffscreen: null
    },
    /**
     * Resets the active canvas data.
     * @param {Object} data - Drawing data object.
     */
    reset(data) {
        state.shapes = data.shapes || {};
        state.beziers = data.beziers || {};
        state.scene = data.scene || [];
        state.selectedShapeIds = data.selectedShapeIds || [];
        state.anchoredShapeIds = data.anchoredShapeIds || [];
        state.focusedVertex = data.focusedVertex || null;
        state.interaction.mode = null;
        state.dragInfo = null;
        state.history = [];
        state.historyIndex = -1;
        state.drawingType = 'canvas';
        state.draftStrokes = [];
        state.currentDraftStroke = null;
        state.deformStartPoints = null;
        state.input.dragStart = null;
        state.deformSettings = data.deformSettings || { sigmaCenter: 120, sigmaDist: 1000, deformDecayMode: 'projection' };
    }
} as any;

/**
 * Key event handlers mapping modifier key state and key codes to action functions.
 * NOTE: Prefer migrating new and existing keyboard actions into interactionMap
 * to centralize interaction definitions and keep the event dispatcher clean.
 * @type {Object}
 */
const keyHandlers = {
    no_mod: {
        x: {
            keydown: [
                {
                    cond: () => state.thicknessEdit.active,
                    f: (ctx) => handleDeleteThicknessPoint(ctx),
                    pushHistory: true,
                    needsRender: true
                },
                {
                    cond: () => {
                        if (!state.focusedVertex) return false;
                        const shape = state.shapes[state.focusedVertex.shapeId];
                        return shape && shape.bezierIds && shape.bezierIds.length > 3;
                    },
                    f: (ctx) => deleteSelectedVertex(ctx),
                    pushHistory: true,
                    needsRender: true
                },
                {
                    cond: () => state.selectedShapeIds.length > 0,
                    f: (ctx) => deleteSelectedShapes(ctx),
                    pushHistory: true,
                    needsRender: true
                }
            ]
        },
        c: { keydown: { f: (ctx) => handleAddCircleStart(ctx), needsRender: true } },
        w: {
            keydown: [
                {
                    cond: () => state.thicknessEdit.active,
                    f: (ctx) => handleTransformStart(ctx),
                    needsRender: true
                },
                {
                    cond: () => !state.thicknessEdit.active,
                    f: (ctx) => handleCreateWrap(ctx),
                    pushHistory: true,
                    needsRender: true
                }
            ],
            keyup: [
                {
                    cond: () => state.thicknessEdit.active,
                    f: (ctx) => handleTransformEnd(ctx),
                    pushHistory: true,
                    needsRender: true
                }
            ]
        },
        '?': { keydown: { f: () => toggleHelpModal() } },
        q: { keydown: { f: (ctx) => handleQuitToGallery(ctx) } },
        '/': { keydown: { f: (ctx) => handleOpenSearch(ctx) } },
        ':': { keydown: { f: (ctx) => handleOpenCommand(ctx) } },
        n: { keydown: { f: (ctx) => handleSearchNext(ctx), needsRender: true } },
        N: { keydown: { f: (ctx) => handleSearchPrev(ctx), needsRender: true } },
        ArrowLeft: { keydown: { f: (ctx) => handleFocusVertexPrev(ctx), needsRender: true } },
        ArrowRight: { keydown: { f: (ctx) => handleFocusVertexNext(ctx), needsRender: true } },
        Escape: { keydown: { f: (ctx) => handleClearVertexFocus(ctx), needsRender: true } },
        a: { keydown: { f: (ctx) => handleToggleAnchor(ctx) } },
        Enter: { keydown: { f: (ctx) => handleEnterAction(ctx) } },

        t: {
            keydown: { f: (ctx) => handleTransformStart(ctx), needsRender: true },
            keyup: { f: (ctx) => handleTransformEnd(ctx), pushHistory: true, needsRender: true }
        },
        d: {
            keydown: { f: (ctx) => handleTransformStart(ctx), needsRender: true },
            keyup: { f: (ctx) => handleTransformEnd(ctx), pushHistory: true, needsRender: true }
        }
    },
    shift: {
        W: { keydown: { f: (ctx) => handleToggleThicknessEdit(ctx), needsRender: true } },
        w: { keydown: { f: (ctx) => handleToggleThicknessEdit(ctx), needsRender: true } },
        S: { keydown: { f: (ctx) => handleToggleOutline(ctx), pushHistory: true, needsRender: true } },
        s: { keydown: { f: (ctx) => handleToggleOutline(ctx), pushHistory: true, needsRender: true } },
        F: { keydown: { f: (ctx) => handleToggleFillEnabled(ctx), pushHistory: true, needsRender: true } },
        f: { keydown: { f: (ctx) => handleToggleFillEnabled(ctx), pushHistory: true, needsRender: true } },
        P: { keydown: { f: (ctx) => handleTogglePatternEdit(ctx), needsRender: true } },
        p: { keydown: { f: (ctx) => handleTogglePatternEdit(ctx), needsRender: true } },
        T: {
            keydown: { f: (ctx) => handleTransformStart(ctx), needsRender: true },
            keyup: { f: (ctx) => handleTransformEnd(ctx), pushHistory: true, needsRender: true }
        },
        t: {
            keydown: { f: (ctx) => handleTransformStart(ctx), needsRender: true },
            keyup: { f: (ctx) => handleTransformEnd(ctx), pushHistory: true, needsRender: true }
        }
    },
    ctrl: {
        z: { keydown: { f: (ctx) => handleUndoAction(ctx), needsRender: true } },
        c: { keydown: { f: (ctx) => handleCopy(ctx) } },
        v: { keydown: { f: (ctx) => handlePaste(ctx) } }
    },
    ctrl_shift: {
        z: { keydown: { f: (ctx) => handleRedoAction(ctx), needsRender: true } }
    }
};

/**
 * Mode event handlers mapping edit state and pointer move events.
 * @type {Object}
 */
const modeHandlers = {
    't-slide': {
        pointermove: { f: (ctx) => handleTSlide(ctx), needsRender: true }
    },
    'd-dist': {
        pointermove: { f: (ctx) => handleDDist(ctx), needsRender: true }
    },
    't-slide-thickness': {
        pointermove: { f: (ctx) => handleTSlideThickness(ctx), needsRender: true }
    },
    'w-slide-thickness': {
        pointermove: { f: (ctx) => handleWSlideThickness(ctx), needsRender: true }
    },
    't-move-thickness': {
        pointermove: { f: (ctx) => handleTMoveThickness(ctx), needsRender: true }
    },
    't-slide-pattern': {
        pointermove: { f: (ctx) => handleTSlidePattern(ctx), needsRender: true }
    },
    't-move-pattern': {
        pointermove: { f: (ctx) => handleTMovePattern(ctx), needsRender: true }
    }
};

/**
 * Interaction map defining event-driven actions depending on current view context.
 * @type {Object}
 */
const interactionMap = {
    view_canvas: {
        pointermove_while_key_press: {
            m: { f: () => handleMove(), keydown: () => updateTransformPivotToCenter(), needsRender: true, pushHistoryOnKeyUp: true }, // shapeの移動
            r: { f: () => handleRotate(), keydown: () => updateTransformPivotToCenter(), needsRender: true, pushHistoryOnKeyUp: true }, // shapeの回転
            s: { f: () => handleScale(), keydown: () => updateTransformPivotToCenter(), needsRender: true, pushHistoryOnKeyUp: true }, // shapeの拡大縮小
            d: { // 下書きレイヤーへの描画
                f: () => {
                    const curr = state.input.pointerOnSVG;
                    const d = getMainCanvasSVGVector();

                    if (!state.currentDraftStroke) {
                        state.currentDraftStroke = [];
                    }
                    state.currentDraftStroke.push({ x: curr.x, y: curr.y });

                    if (state.canvas.draftOffscreen) {
                        const draftCtx = state.canvas.draftOffscreen.getContext('2d');
                        draftCtx.beginPath();
                        draftCtx.moveTo(curr.x - d.dx, curr.y - d.dy);
                        draftCtx.lineTo(curr.x, curr.y);
                        draftCtx.strokeStyle = '#000000';
                        draftCtx.lineWidth = 1;
                        draftCtx.stroke();
                    }
                },
                keyup: () => {
                    if (state.currentDraftStroke && state.currentDraftStroke.length > 2) {
                        if (!state.draftStrokes) state.draftStrokes = [];
                        state.draftStrokes.push(state.currentDraftStroke);
                    }
                    state.currentDraftStroke = null;
                },
                needsRender: true
            },
            k: {
                keydown: () => {
                    const guide = getDom('#deform-guide');
                    if (guide) guide.classList.remove('hidden');

                    if (state.anchoredShapeIds.length !== 1) return;
                    const anchorId = state.anchoredShapeIds[0];
                    const anchorShape = state.shapes[anchorId];
                    if (!anchorShape || anchorShape.type !== 'polyline') return;

                    state.deformStartPoints = {};
                    state.selectedShapeIds.forEach(id => {
                        const shape = state.shapes[id];
                        if (shape && shape.type === 'polyline' && shape.points) {
                            state.deformStartPoints[id] = shape.points.map(p => ({ x: p.x, y: p.y }));
                        }
                    });
                    state.input.dragStart = { x: state.input.pointer.x, y: state.input.pointer.y };
                },
                keyup: () => {
                    const guide = getDom('#deform-guide');
                    if (guide) guide.classList.add('hidden');
                },
                f: () => handlePolylineDeform(),
                needsRender: true,
                pushHistoryOnKeyUp: true
            }
        },
        key_down: {
            p: {
                f: (ctx) => handleConvertRasterToPolyline(ctx),
                needsRender: true,
                pushHistory: true
            }
        },
        pointerdown: {},
        shift_pointerdown: {},
        ctrl_wheel: {
            f: () => handleZoom(), needsRender: true,
        },
        drag_no_key: {
            pointerdown: {
                needsRender: true
            },
            pointermove: {
                f: (event) => {
                    updateSelectionByDragRect();
                },
                needsRender: true
            },
            pointerup: {
                needsRender: true,
                pushHistory: true
            }
        }
    },
    view_gallery: {
        click_selector: {
            ['#btn-new-draw']: { f: () => toggleClassDom('#new-draw-menu', 'hidden') },
            ['#btn-new-canvas']: { f: () => startNewDrawing('canvas') },
            ['#btn-new-pattern']: { f: () => startNewDrawing('pattern') },
            ['#btn-new-import']: { f: () => importImageFile() },
            ['body']: { f: () => addClassDom('#new-draw-menu', 'hidden') },
        }
    }
};

/** @type {IDBDatabase} */
let db;

const getDomsOf = (elm, pat) => Array.from(elm.querySelectorAll(pat)) as any;
const getDomOf = (elm, pat) => getDomsOf(elm, pat)[0] as any;
const getDoms = (pat) => getDomsOf(document, pat) as any;
const getDom = (pat) => getDomsOf(document, pat)[0] as any;

/**
 * Toggles a class on the matched DOM element.
 * @param {string} pat - CSS Selector pattern.
 * @param {string} className - Class name to toggle.
 * @returns {boolean|undefined}
 */
const toggleClassDom = (pat, className) => getDom(pat)?.classList.toggle(className);

/**
 * Adds a class to the matched DOM element.
 * @param {string} pat - CSS Selector pattern.
 * @param {string} className - Class name to add.
 */
const addClassDom = (pat, className) => getDom(pat)?.classList.add(className);

/**
 * Removes a class from the matched DOM element.
 * @param {string} pat - CSS Selector pattern.
 * @param {string} className - Class name to remove.
 */
const removeClassDom = (pat, className) => getDom(pat)?.classList.remove(className);

/**
 * Creates a new DOM element with properties.
 * @param {string} elementName - Tag name of the element.
 * @param {Object} attributes - Attributes/properties to assign.
 * @returns {Element}
 */
const newElm = (elementName, attributes) => Object.assign(document.createElement(elementName), attributes);

/**
 * Filters attributes of an object by keys.
 * @param {Object} obj - The source object.
 * @param {Array<string>} keys - Array of keys to retain.
 * @returns {Object}
 */
const filterAttribute = (obj, keys) => Object.fromEntries(keys.map(key => [key, obj[key]]));

/**
 * Converts screen coordinate to SVG local viewport coordinate.
 * @param {Event} e - Pointer event.
 * @param {SVGSVGElement} svg - SVG root element.
 * @param {SVGElement} vp - Viewport group element.
 * @returns {SVGPoint}
 */
const getSVGPoint = (e, svg, vp) => Object.assign(svg.createSVGPoint(), state.input.pointer).matrixTransform(vp.getScreenCTM().inverse());

/**
 * Gets active pointer coordinate in Main Canvas SVG context.
 * @returns {SVGPoint}
 */
const getMainCanvasSVGPoint = () => getSVGPoint(null, getDom('#guide-svg'), getDom('#guide-svg #viewport'));

/**
 * Converts screen vector to SVG local viewport vector.
 * @param {Object} screenVector - Vector in screen coordinates {x, y}.
 * @param {SVGSVGElement} svg - SVG root element.
 * @param {SVGElement} vp - Viewport group element.
 * @returns {Object} {dx, dy}
 */
const getSVGVector = (screenVector, svg, vp) => {
    const p1 = Object.assign(svg.createSVGPoint(), { x: 0, y: 0 }).matrixTransform(vp.getScreenCTM().inverse());
    const p2 = Object.assign(svg.createSVGPoint(), screenVector).matrixTransform(vp.getScreenCTM().inverse());
    return { dx: p2.x - p1.x, dy: p2.y - p1.y };
};

/**
 * Gets pointer movement delta vector in Main Canvas SVG context.
 * @returns {Object} {dx, dy}
 */
const getMainCanvasSVGVector = () => getSVGVector(state.input.dPointer, getDom('#guide-svg'), getDom('#guide-svg #viewport'));

/**
 * Checks if current active element is an editable input or textarea.
 * @returns {boolean}
 */
const isFocusEditable = () => !!(document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA' || document.activeElement.isContentEditable));

/**
 * Scans existing IDs to initialize the ID incrementer counter.
 */
function initializeIdCounter() {
    const allIds = [...Object.keys(state.shapes), ...Object.keys(state.beziers)];
    const max = Math.max(0, ...allIds.map(id => {
        const m = id?.match(/[0-9]+/);
        return m ? parseInt(m[0], 10) : 0;
    }));
    state.nextIdCounter = max + 1;
}

/**
 * Generates a new unique ID with prefix.
 * @param {string} prefix - The ID prefix (e.g., 's', 'b', 'l').
 * @returns {string}
 */
function generateId(prefix) {
    if (!state.nextIdCounter) state.nextIdCounter = 1;
    const id = `${prefix}${state.nextIdCounter}`;
    state.nextIdCounter++;
    return id;
}

/**
 * Replacer function for state serialization to JSON, optimizing precision and stripping caches.
 * @param {string} key - Object key.
 * @param {*} value - Object value.
 * @returns {*}
 */
function stateReplacer(key, value) {
    if (key === 'controlPoints' || key === 'samplePointByT' || key === 'boundingBox') {
        return undefined;
    }
    if (typeof value === 'number') {
        return Math.round(value * 10000) / 10000;
    }
    return value;
}

/**
 * Initializes offscreen canvases.
 */
function initOffscreenCanvases() {
    const sizeAttrs = filterAttribute(state.canvas, ['width', 'height']);
    state.canvas.underOffscreen = newElm('canvas', sizeAttrs);
    state.canvas.activeOffscreen = newElm('canvas', sizeAttrs);
    state.canvas.overOffscreen = newElm('canvas', sizeAttrs);
    state.canvas.draftOffscreen = newElm('canvas', sizeAttrs);
    initWebGLPatternRenderer();
}

/**
 * Resizes offscreen canvases according to state dimensions.
 */
function resizeOffscreenCanvases() {
    if (state.canvas.underOffscreen) {
        state.canvas.underOffscreen.width = state.canvas.width;
        state.canvas.underOffscreen.height = state.canvas.height;
    }
    if (state.canvas.activeOffscreen) {
        state.canvas.activeOffscreen.width = state.canvas.width;
        state.canvas.activeOffscreen.height = state.canvas.height;
    }
    if (state.canvas.overOffscreen) {
        state.canvas.overOffscreen.width = state.canvas.width;
        state.canvas.overOffscreen.height = state.canvas.height;
    }
    if (state.canvas.draftOffscreen) {
        state.canvas.draftOffscreen.width = state.canvas.width;
        state.canvas.draftOffscreen.height = state.canvas.height;
    }
    if (state.patternWebGLCanvas) {
        state.patternWebGLCanvas.width = state.canvas.width;
        state.patternWebGLCanvas.height = state.canvas.height;
    }
}

/**
 * Helper: Gets the modifier key state from raw Keyboard or Mouse events.
 * @param {Event} rawEvent - Raw event instance.
 * @returns {string} One of: 'no_mod', 'ctrl', 'shift', 'ctrl_shift'
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

(window as any).state = state;
(window as any).keyHandlers = keyHandlers;
(window as any).interactionMap = interactionMap;
(window as any).modeHandlers = modeHandlers;
(window as any).getDomsOf = getDomsOf;
(window as any).getDomOf = getDomOf;
(window as any).getDoms = getDoms;
(window as any).getDom = getDom;
(window as any).toggleClassDom = toggleClassDom;
(window as any).addClassDom = addClassDom;
(window as any).removeClassDom = removeClassDom;
(window as any).newElm = newElm;
(window as any).filterAttribute = filterAttribute;
(window as any).getSVGPoint = getSVGPoint;
(window as any).getMainCanvasSVGPoint = getMainCanvasSVGPoint;
(window as any).getSVGVector = getSVGVector;
(window as any).getMainCanvasSVGVector = getMainCanvasSVGVector;
(window as any).isFocusEditable = isFocusEditable;
(window as any).initializeIdCounter = initializeIdCounter;
(window as any).generateId = generateId;
(window as any).stateReplacer = stateReplacer;
(window as any).initOffscreenCanvases = initOffscreenCanvases;
(window as any).resizeOffscreenCanvases = resizeOffscreenCanvases;
(window as any).getModifierState = getModifierState;

Object.defineProperty(window, 'db', {
    get() { return db; },
    set(v) { db = v; },
    configurable: true
});

export { };


