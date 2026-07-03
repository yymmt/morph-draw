/**
 * MorphDraw - テスト & デバッグヘルパー
 */

(function() {
    // 状態のリセット & IndexedDBクリア
    async function reset() {
        state.shapes = {};
        state.beziers = {};
        state.layers = {};
        state.scene = [];
        state.selectedShapeIds = [];
        state.zoom = 1;
        state.rotation = 0;
        state.pan = { x: 0, y: 0 };
        state.history = [];
        state.historyIndex = -1;

        if (typeof db !== 'undefined' && db) {
            try {
                await new Promise((resolve, reject) => {
                    const tx = db.transaction('drawings', 'readwrite');
                    const store = tx.objectStore('drawings');
                    const req = store.clear();
                    req.onsuccess = () => resolve();
                    req.onerror = (e) => reject(e);
                });
            } catch (e) {
                console.error('Failed to clear IndexedDB:', e);
            }
        }
        
        switchView('gallery');
        loadGallery();
        if (typeof rasterizeInactiveLayers !== 'undefined') rasterizeInactiveLayers();
        renderCanvas();
    }

    // 形状データのJSONインポート/エクスポート
    function exportScene() {
        return JSON.stringify({
            shapes: state.shapes,
            beziers: state.beziers,
            layers: state.layers,
            scene: state.scene
        }, typeof stateReplacer !== 'undefined' ? stateReplacer : undefined);
    }

    function importScene(jsonStr) {
        const data = JSON.parse(jsonStr);
        state.shapes = data.shapes || {};
        state.beziers = data.beziers || {};
        state.layers = data.layers || {};
        state.scene = data.scene || [];
        state.selectedShapeIds = [];
        
        // 親IDの紐付け復元
        Object.entries(state.shapes).forEach(([sid, shape]) => {
            if (shape.bezierIds) {
                shape.bezierIds.forEach(bid => {
                    if (state.beziers[bid]) {
                        state.beziers[bid].parentId = sid;
                    }
                });
            }
        });

        resolveBezierDependencies();
        if (typeof rasterizeInactiveLayers !== 'undefined') rasterizeInactiveLayers();
        renderCanvas();
        updatePropertiesPanel();
        renderLayerList();
    }

    /**
     * 操作エミュレーション
     */
    async function emulateDrag(key, startX, startY, deltaX, deltaY, options = {}) {
        const { shift = false, isDrag = false, steps = 5 } = options;
        const rawEvent = {
            ctrlKey: false,
            metaKey: false,
            altKey: false,
            shiftKey: shift,
            preventDefault: () => {}
        };

        if (key) {
            state.input.keys[key] = true;
            await handleInputUpdate('keydown', key, rawEvent);
        }
        if (shift) {
            state.input.keys['Shift'] = true;
            await handleInputUpdate('keydown', 'Shift', rawEvent);
        }
        state.input.pointer = { x: startX, y: startY };

        if (state.interaction.mode && !isDrag) {
            state.dragInfo = {
                start: { x: startX, y: startY },
                type: 'drag'
            };
        }

        if (isDrag) {
            state.input.isPointerDown = true;
            state.input.dragStart = { x: startX, y: startY };
            await handleInputUpdate('pointerdown', null, rawEvent);
        }

        for (let i = 1; i <= steps; i++) {
            state.input.pointer = {
                x: startX + (deltaX * i) / steps,
                y: startY + (deltaY * i) / steps
            };
            await handleInputUpdate('pointermove', null, rawEvent);
        }

        if (isDrag) {
            state.input.isPointerDown = false;
            state.input.dragStart = null;
            await handleInputUpdate('pointerup', null, rawEvent);
        }

        if (key) {
            state.input.keys[key] = false;
            await handleInputUpdate('keyup', key, rawEvent);
        }
        if (shift) {
            state.input.keys['Shift'] = false;
            await handleInputUpdate('keyup', 'Shift', rawEvent);
        }
    }

    async function emulateKey(key, options = {}) {
        const { shift = false } = options;
        const rawEvent = {
            ctrlKey: false,
            metaKey: false,
            altKey: false,
            shiftKey: shift,
            preventDefault: () => {}
        };
        state.input.keys[key] = true;
        await handleInputUpdate('keydown', key, rawEvent);
        state.input.keys[key] = false;
        await handleInputUpdate('keyup', key, rawEvent);
    }

    // URLハッシュ監視によるシーン自動構築
    async function checkHashAndLoadTest() {
        const hash = window.location.hash;
        if (!hash.startsWith('#test=')) return;
        const testType = hash.substring(6);

        startNewDrawing();

        if (testType === 'circle') {
            addShapeAt('circle', 400, 300);
            const shapeIds = Object.keys(state.shapes).filter(id => !state.layers[id]);
            state.selectedShapeIds = shapeIds;
            renderCanvas();
            updatePropertiesPanel();
            renderLayerList();
        } else if (testType === 'wrap') {
            addShapeAt('circle', 300, 300);
            addShapeAt('circle', 500, 300);
            const shapeIds = Object.keys(state.shapes).filter(id => !state.layers[id]);
            state.selectedShapeIds = shapeIds; // 両方選択
            renderCanvas();
            updatePropertiesPanel();
            renderLayerList();
        } else if (testType === 'connector') {
            addShapeAt('circle', 300, 300);
            addShapeAt('circle', 500, 300);
            const shapeIds = Object.keys(state.shapes).filter(id => !state.layers[id]);
            if (shapeIds.length >= 2) {
                state.selectedShapeIds = [shapeIds[0], shapeIds[1]];
                createWrap();
            }
            renderCanvas();
            updatePropertiesPanel();
            renderLayerList();
        }
    }

    let measures = [];

    function resetMeasure() {
        measures = [];
        console.log("Measures reset.");
    }

    function addMeasure(duration, coonsPatchCount) {
        measures.push({ duration, coonsPatchCount });
    }

    function printMeasure() {
        if (measures.length === 0) {
            console.log("No samples recorded.");
            return;
        }
        const sampleCount = measures.length;
        const totalDuration = measures.reduce((sum, m) => sum + m.duration, 0);
        const totalCoonsPatchCount = measures.reduce((sum, m) => sum + m.coonsPatchCount, 0);
        const avgDuration = totalDuration / sampleCount;
        const avgCoonsPatchCount = totalCoonsPatchCount / sampleCount;
        console.log(`Samples: ${sampleCount}`);
        console.log(`Avg Duration: ${avgDuration.toFixed(4)} ms`);
        console.log(`Avg Coons Patch Calls: ${avgCoonsPatchCount.toFixed(4)}`);
    }

    window.__debug__ = {
        state: state,
        reset,
        exportScene,
        importScene,
        emulateDrag,
        emulateKey,
        checkHashAndLoadTest,
        resetMeasure,
        addMeasure,
        printMeasure
    };

    window.addEventListener('hashchange', checkHashAndLoadTest);
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', checkHashAndLoadTest);
    } else {
        checkHashAndLoadTest();
    }
})();
