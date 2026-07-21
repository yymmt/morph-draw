import { beforeAll, describe, test, expect } from 'vitest';

// Initialize mock DOM environment before importing app source files
beforeAll(() => {
    document.body.innerHTML = `
        <div id="app">
            <div id="view-gallery">
                <button id="btn-new-draw"></button>
                <div id="new-draw-menu" class="hidden"></div>
                <button id="btn-new-canvas"></button>
                <button id="btn-new-pattern"></button>
                <button id="btn-new-import"></button>
                <div id="gallery-list-canvas"></div>
                <div id="gallery-list-pattern"></div>
                <div id="gallery-list-import"></div>
            </div>
            <div id="view-canvas">
                <button id="btn-back-gallery"></button>
                <button id="btn-toggle-settings"></button>
                <div id="settings-panel" class="collapsed"></div>
                <input id="input-draw-name">
                <input id="input-canvas-width" value="2000">
                <input id="input-canvas-height" value="2000">
                <button id="btn-save-image-settings"></button>
                <input id="slider-deform-dl" type="range" value="100">
                <span id="val-deform-dl">100</span>
                <button id="btn-add-layer"></button>
                <div id="layer-list"></div>
                <div id="deform-guide"></div>
                <aside id="minimap-panel" class="collapsed">
                    <canvas id="minimap-canvas"></canvas>
                    <button id="btn-toggle-minimap"></button>
                </aside>
                <svg id="guide-svg">
                    <g id="viewport"></g>
                </svg>
            </div>
        </div>
        <template id="tmpl-gallery-card">
            <div class="card-preview"></div>
            <div class="card-info">
                <div class="card-title-group">
                    <span class="card-name"></span>
                    <span class="card-id-badge"></span>
                </div>
                <button class="btn-card-delete"><i class="bi bi-trash"></i></button>
            </div>
        </template>
        <template id="tmpl-layer-item">
            <div class="layer-info">
                <span class="layer-visibility-btn"><i class="bi"></i></span>
                <input class="layer-name-input" type="text">
            </div>
            <div class="layer-controls">
                <button class="layer-control-btn btn-layer-delete"><i class="bi bi-trash"></i></button>
            </div>
        </template>
    `;

    // Mock URL.createObjectURL and URL.revokeObjectURL
    window.URL.createObjectURL = () => 'blob:mock-url';
    window.URL.revokeObjectURL = () => {};

    // Mock HTMLCanvasElement.prototype.getContext for jsdom
    window.HTMLCanvasElement.prototype.getContext = function (type: string) {
        if (type === '2d') {
            return {
                clearRect: () => {},
                save: () => {},
                restore: () => {},
                translate: () => {},
                scale: () => {},
                rotate: () => {},
                drawImage: () => {},
                beginPath: () => {},
                moveTo: () => {},
                lineTo: () => {},
                stroke: () => {},
                fillRect: () => {},
                fillText: () => {},
                measureText: () => ({ width: 0 })
            } as any;
        }
        return null;
    } as any;

    // Mock SVG elements methods for jsdom
    (window as any).SVGSVGElement.prototype.createSVGPoint = () => ({
        x: 0,
        y: 0,
        matrixTransform: () => ({ x: 0, y: 0 })
    });
    (window as any).SVGElement.prototype.getScreenCTM = () => ({
        inverse: () => ({})
    });

    // Mock crypto.randomUUID
    if (!window.crypto) {
        (window as any).crypto = {};
    }
    if (!window.crypto.randomUUID) {
        window.crypto.randomUUID = () => 'test-uuid-1234';
    }
});

// Import modules to load application logic into jsdom
import './mdmath';
import './webgl_renderer';
import './state';
import './db';
import './history';
import './renderer';
import './editor';
import './main';

// FUTURE: Phase out 'window as any' and 'global.d.ts' in favor of standard ES Modules (export/import) as refactoring opportunities arise.
// Gain access to global functions registered on window
const {
    state,
    stateReplacer,
    resolveBezierDependencies,
    MDMath,
    initPatternCorners,
    generateCoonsPatchMesh,
    generateStrokeCoonsPatchMesh,
    getCombinedBounds,
    handleInputUpdate,
    handleInputUpdate_old
} = window as any;

describe('MorphDraw Unit Tests', () => {

    test('1. Serialization & Cache Recovery', () => {
        state.shapes = {
            'shape-1': {
                id: 'shape-1',
                bezierIds: ['bez-1'],
                type: 'bezier-group'
            }
        };
        state.beziers = {
            'bez-1': {
                id: 'bez-1',
                generator: {
                    type: 'arc',
                    params: { x: 100, y: 100, r: 50, startAngle: 0, endAngle: 1.57 }
                },
                controlPoints: [
                    { v: { x: 150, y: 100 } },
                    { v: { x: 150, y: 127 } },
                    { v: { x: 135, y: 150 } },
                    { v: { x: 100, y: 150 } }
                ],
                samplePointByT: {}
            }
        };
        state.selectedShapeIds = ['shape-1'];

        const serialized = JSON.stringify({ shapes: state.shapes, beziers: state.beziers }, stateReplacer);
        const parsed = JSON.parse(serialized);

        expect(parsed.beziers['bez-1'].controlPoints).toBeUndefined();

        state.beziers = parsed.beziers;
        state.shapes = parsed.shapes;
        resolveBezierDependencies();

        const recoveredBez = state.beziers['bez-1'];
        expect(recoveredBez.controlPoints).toBeDefined();
        expect(recoveredBez.controlPoints.length).toBe(4);
    });

    test('2. Dynamic Thickness Interpolation', () => {
        const testShape = {
            id: 's_test',
            type: 'bezier-group',
            bezierIds: ['bez-1'],
            style: { fill: '#2196F3', opacity: 0.7, outline: true, fillEnabled: true },
            strokeWidthData: [{ t: 0, w: 10 }, { t: 0.5, w: 2 }, { t: 1, w: 10 }]
        };
        state.shapes['s_test'] = testShape;
        state.selectedShapeIds = ['s_test'];

        const w0 = MDMath.getShapeThickness(state.shapes['s_test'], 0.0);
        const w025 = MDMath.getShapeThickness(state.shapes['s_test'], 0.25);
        const w05 = MDMath.getShapeThickness(state.shapes['s_test'], 0.5);
        const w1 = MDMath.getShapeThickness(state.shapes['s_test'], 1.0);

        expect(w0).toBe(10);
        expect(w025).toBeCloseTo(6, 4);
        expect(w05).toBe(2);
        expect(w1).toBe(10);
    });

    test('3. WebGL Coons Patch Mesh Boundary Calculation', () => {
        const testStatePattern = {
            shapes: {
                's_pattern': {
                    id: 's_pattern',
                    type: 'bezier-group',
                    bezierIds: ['b1', 'b2', 'b3', 'b4'],
                    style: { fillPattern: 'sample' }
                }
            },
            beziers: {
                'b1': {
                    id: 'b1',
                    controlPoints: [{ v: { x: 100, y: 100 } }, { v: { x: 133, y: 100 } }, { v: { x: 166, y: 100 } }, { v: { x: 200, y: 100 } }],
                    samplePointByT: { 0: { x: 100, y: 100 }, 1: { x: 200, y: 100 } }
                },
                'b2': {
                    id: 'b2',
                    controlPoints: [{ v: { x: 200, y: 100 } }, { v: { x: 200, y: 133 } }, { v: { x: 200, y: 166 } }, { v: { x: 200, y: 200 } }],
                    samplePointByT: { 0: { x: 200, y: 100 }, 1: { x: 200, y: 200 } }
                },
                'b3': {
                    id: 'b3',
                    controlPoints: [{ v: { x: 200, y: 200 } }, { v: { x: 166, y: 200 } }, { v: { x: 133, y: 200 } }, { v: { x: 100, y: 200 } }],
                    samplePointByT: { 0: { x: 200, y: 200 }, 1: { x: 100, y: 200 } }
                },
                'b4': {
                    id: 'b4',
                    controlPoints: [{ v: { x: 100, y: 200 } }, { v: { x: 100, y: 166 } }, { v: { x: 100, y: 133 } }, { v: { x: 100, y: 100 } }],
                    samplePointByT: { 0: { x: 100, y: 200 }, 1: { x: 100, y: 100 } }
                }
            },
            selectedShapeIds: ['s_pattern']
        };

        state.reset(testStatePattern);

        initPatternCorners(state.shapes['s_pattern']);
        const corners = state.shapes['s_pattern'].patternCorners;
        expect(corners).toBeDefined();
        expect(typeof corners.TL).toBe('number');
        expect(typeof corners.TR).toBe('number');
        expect(typeof corners.BR).toBe('number');
        expect(typeof corners.BL).toBe('number');

        const mesh = generateCoonsPatchMesh(state.shapes['s_pattern']);
        expect(mesh).toBeDefined();
        expect(mesh.length).toBe(33 * 33 * 2);

        const strokeMesh = generateStrokeCoonsPatchMesh(state.shapes['s_pattern']);
        expect(strokeMesh).toBeDefined();
        expect(strokeMesh.length).toBe(33 * 33 * 2);
    });

    test('4. Combined Bounds Calculation', () => {
        const testStateC = {
            shapes: {
                's1': { id: 's1', type: 'bezier-group', name: 'circle 1', bezierIds: ['b1'] },
                's2': { id: 's2', type: 'bezier-group', name: 'circle 2', bezierIds: ['b2'] }
            },
            beziers: {
                'b1': {
                    id: 'b1',
                    generator: { type: 'arc', params: { x: 100, y: 100, r: 50, startAngle: 0, endAngle: 1.57 } },
                    controlPoints: [{ v: { x: 100, y: 100 } }], boundingBox: { x: 50, y: 50, w: 100, h: 100 }
                },
                'b2': {
                    id: 'b2',
                    generator: { type: 'arc', params: { x: 300, y: 300, r: 50, startAngle: 0, endAngle: 1.57 } },
                    controlPoints: [{ v: { x: 300, y: 300 } }], boundingBox: { x: 250, y: 250, w: 100, h: 100 }
                }
            },
            selectedShapeIds: ['s1', 's2']
        };

        state.reset(testStateC);

        const bounds = getCombinedBounds(state.selectedShapeIds);
        expect(bounds.cx).toBe(200);
        expect(bounds.cy).toBe(200);
    });

    test('5. Raster to Polyline Conversion', async () => {
        const testStateRaster = {
            shapes: {},
            beziers: {},
            scene: ['layer-1'],
            selectedLayerId: 'layer-1',
            draftStrokes: [],
            currentDraftStroke: null
        };

        state.reset(testStateRaster);
        state.shapes['layer-1'] = { id: 'layer-1', type: 'layer', childIds: [] };
        state.scene = ['layer-1'];
        state.selectedLayerId = 'layer-1';
        state.view = 'canvas';

        // Simulate drawing with 'd' key held down
        state.input.keys['d'] = true;

        const strokePoints = [
            { x: 100, y: 100 },
            { x: 110, y: 105 },
            { x: 120, y: 110 },
            { x: 130, y: 115 },
            { x: 140, y: 120 }
        ];

        for (const pt of strokePoints) {
            state.input.pointerOnSVG = pt;
            await handleInputUpdate({ type: 'pointermove' });
        }

        // Simulate releasing 'd' key
        state.input.keys['d'] = false;
        await handleInputUpdate_old('keyup', 'd', { preventDefault: () => {} });
        await handleInputUpdate({ type: 'keyup', key: 'd' });

        expect(state.draftStrokes.length).toBe(1);

        // Press 'p' key to convert raster to polyline
        state.input.keys['p'] = true;
        await handleInputUpdate_old('keydown', 'p', { preventDefault: () => {} });
        await handleInputUpdate({ type: 'keydown', key: 'p' });

        const polylineShape = Object.values(state.shapes).find((s: any) => s.type === 'polyline') as any;
        expect(polylineShape).toBeDefined();
        expect(polylineShape.points.length).toBeGreaterThanOrEqual(2);
    });
});
