/**
 * MorphDraw - テスト & デバッグヘルパー
 */

(function() {
    // 状態のリセット & IndexedDBクリア
    async function reset() {
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
            scene: state.scene,
            anchoredShapeIds: state.anchoredShapeIds
        }, typeof stateReplacer !== 'undefined' ? stateReplacer : undefined);
    }

    function importScene(jsonStr) {
        const data = JSON.parse(jsonStr);
        state.shapes = data.shapes || {};
        state.beziers = data.beziers || {};
        state.scene = data.scene || [];
        state.anchoredShapeIds = data.anchoredShapeIds || [];
        state.selectedShapeIds = [];
        resolveBezierDependencies();
        if (typeof rasterizeInactiveLayers !== 'undefined') rasterizeInactiveLayers();
        renderCanvas();
    }

    /**
     * 操作エミュレーション
     * 移動操作 'm' は isDrag: false（ドラッグなしマウス移動）を前提とする
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

        // 1. キーダウン
        if (key) {
            state.input.keys[key] = true;
            await handleInputUpdate('keydown', key, rawEvent);
        }
        if (shift) {
            state.input.keys['Shift'] = true;
            await handleInputUpdate('keydown', 'Shift', rawEvent);
        }
        state.input.pointer = { x: startX, y: startY };

        // dragInfoのスタート地点初期化（isDrag: false の移動変形時のため）
        if (state.interaction.mode && !isDrag) {
            state.dragInfo = {
                start: { x: startX, y: startY },
                type: 'key-hold'
            };
        }

        if (isDrag) {
            state.input.isPointerDown = true;
            state.input.dragStart = { x: startX, y: startY };
            await handleInputUpdate('pointerdown', null, rawEvent);
        }

        // 2. pointermove (複数ステップに分けて徐々に動かす)
        for (let i = 1; i <= steps; i++) {
            state.input.pointer = {
                x: startX + (deltaX * i) / steps,
                y: startY + (deltaY * i) / steps
            };
            await handleInputUpdate('pointermove', null, rawEvent);
        }

        // 3. pointerup (ドラッグ終了)
        if (isDrag) {
            state.input.isPointerDown = false;
            state.input.dragStart = null;
            await handleInputUpdate('pointerup', null, rawEvent);
        }

        // 4. キーアップ
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

        // 新規キャンバスの開始
        await startNewDrawing();

        if (testType === 'circle') {
            // 中央に円を配置して選択状態にする
            addShapeAt('circle', 400, 300);
            const shapeIds = Object.keys(state.shapes).filter(id => state.shapes[id].type !== 'layer');
            state.selectedShapeIds = shapeIds;
            renderCanvas();
        } else if (testType === 'wrap') {
            // 円を2つ配置し、1つを選択状態（黄色）、もう1つをアンカー状態（オレンジ）にする
            addShapeAt('circle', 300, 300);
            addShapeAt('circle', 500, 300);
            
            const shapeIds = Object.keys(state.shapes).filter(id => state.shapes[id].type !== 'layer');
            if (shapeIds.length >= 2) {
                state.selectedShapeIds = [shapeIds[0]];
                state.anchoredShapeIds = [shapeIds[1]];
            }
            renderCanvas();
        } else if (testType === 'connector') {
            // 円を2つ配置し、コネクターで接続する
            addShapeAt('circle', 300, 300);
            addShapeAt('circle', 500, 300);
            
            const shapeIds = Object.keys(state.shapes).filter(id => state.shapes[id].type !== 'layer');
            if (shapeIds.length >= 2) {
                state.anchoredShapeIds = [shapeIds[0], shapeIds[1]];
                createWrap();
            }
            renderCanvas();
        } else if (testType === 'edit-vertex') {
            // 円を2つ配置し、wrapさせて、そのwrapされたShapeを選択状態にする
            addShapeAt('circle', 300, 300);
            addShapeAt('circle', 500, 350);
            
            const shapeIds = Object.keys(state.shapes).filter(id => state.shapes[id].name && state.shapes[id].name.startsWith('circle'));
            if (shapeIds.length >= 2) {
                state.anchoredShapeIds = [shapeIds[0], shapeIds[1]];
                createWrap();
                // 生成されたwrapを選択状態にする
                const wrapShape = Object.values(state.shapes).find(s => s.name && s.name.startsWith('wrap'));
                if (wrapShape) {
                    state.selectedShapeIds = [wrapShape.id];
                    state.anchoredShapeIds = []; // アンカーは解除

                    // 3つめの円Cを追加
                    addShapeAt('circle', 400, 500);
                    const allCircles = Object.keys(state.shapes).filter(id => state.shapes[id].name && state.shapes[id].name.startsWith('circle'));
                    const circleCId = allCircles.find(id => id !== shapeIds[0] && id !== shapeIds[1]);

                    if (circleCId) {
                        // 1. wrapのいずれかの頂点選択 (ArrowRightキーを1回押下してフォーカス)
                        await emulateKey('ArrowRight');

                        // 2. aキーを押下して追加待ち状態にする
                        await emulateKey('a');

                        // 3. 円Cを選択状態にする
                        state.selectedShapeIds = [circleCId];

                        // 4. Enterキーを押下
                        await emulateKey('Enter');
                    }
                }
            }
            renderCanvas();
        }
    }

    // グローバルデバッグAPIの設定
    window.__debug__ = {
        state: state,
        reset,
        exportScene,
        importScene,
        emulateDrag,
        emulateKey,
        checkHashAndLoadTest
    };

    // 初期化トリガー
    window.addEventListener('hashchange', checkHashAndLoadTest);
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', checkHashAndLoadTest);
    } else {
        checkHashAndLoadTest();
    }
})();
