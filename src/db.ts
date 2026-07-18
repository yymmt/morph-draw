/**
 * @file db.js
 * @description Manages drawing data storage using IndexedDB, imports, drawing setup/creation, and layer listing/deletions.
 */

/**
 * Loads a drawing preview image as a WebGL texture.
 * @param {string} id - The drawing ID to load.
 * @returns {Promise<WebGLTexture|null>} Resolves with WebGLTexture or null if failed.
 */
function loadDrawingTexture(id) {
    return new Promise((resolve) => {
        if (!id) {
            resolve(null);
            return;
        }
        if (state.webglTextures && state.webglTextures[id]) {
            resolve(state.webglTextures[id]);
            return;
        }
        if (id === 'sample' || id === 'brush_sample') {
            resolve(state.webglTextures ? state.webglTextures[id] : null);
            return;
        }
        if (!db) {
            resolve(null);
            return;
        }
        try {
            const tx = db.transaction('drawings', 'readonly');
            const store = tx.objectStore('drawings');
            const request = store.get(id);

            request.onsuccess = () => {
                const data = request.result;
                if (data && data.preview) {
                    const img = new Image();
                    let src = '';
                    let isObjectURL = false;

                    if (data.preview instanceof Blob) {
                        src = URL.createObjectURL(data.preview);
                        isObjectURL = true;
                    } else if (typeof data.preview === 'string') {
                        src = data.preview;
                    }

                    img.onload = () => {
                        const gl = state.gl;
                        if (gl) {
                            const texture = gl.createTexture();
                            gl.bindTexture(gl.TEXTURE_2D, texture);
                            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
                            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);

                            const isPowerOf2 = (val) => (val & (val - 1)) === 0;
                            const isPot = isPowerOf2(img.width) && isPowerOf2(img.height);
                            if (isPot) {
                                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
                                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
                                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
                                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
                                gl.generateMipmap(gl.TEXTURE_2D);
                            } else {
                                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
                                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
                                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
                                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
                            }

                            state.webglTextures[id] = texture;
                        }
                        if (isObjectURL) {
                            URL.revokeObjectURL(src);
                        }
                        resolve(state.webglTextures[id] || null);
                    };

                    img.onerror = () => {
                        if (isObjectURL) {
                            URL.revokeObjectURL(src);
                        }
                        resolve(null);
                    };

                    img.src = src;
                } else {
                    resolve(null);
                }
            };

            request.onerror = () => {
                resolve(null);
            };
        } catch (e) {
            console.warn(`Failed to access drawings database for texture ${id}:`, e);
            resolve(null);
        }
    });
}

/**
 * Initializes IndexedDB instances and loads the gallery views.
 */
function initDB() {
    const request = indexedDB.open('morph-draw-db', 1);
    request.onupgradeneeded = (e) => {
        const dbInstance = (e.target as any).result;
        if (!dbInstance.objectStoreNames.contains('drawings')) {
            dbInstance.createObjectStore('drawings', { keyPath: 'id' });
        }
    };
    request.onsuccess = (e) => { 
        db = (e.target as any).result; 
        loadGallery(); 
    };
}

/**
 * Switches the active viewport panel display.
 * @param {string} viewId - Selector identifier for the target viewport ('gallery' or 'canvas').
 */
function switchView(viewId) {
    state.view = viewId;
    getDoms('.view').forEach(v => v.classList.remove('active'));
    getDom(`#view-${viewId}`).classList.add('active');
}

/**
 * Saves current drawing state and configurations into IndexedDB.
 * @returns {Promise<void>} Resolves when IndexedDB operations finish.
 */
async function saveDrawing() {
    if (!state.currentDrawId || !db) return;

    const baseW = state.canvas.width || 800;
    const baseH = state.canvas.height || 600;
    const scale = Math.min(512 / baseW, 512 / baseH);
    const thumbW = Math.round(baseW * scale);
    const thumbH = Math.round(baseH * scale);

    const tempCanvas = newElm('canvas', { width: thumbW, height: thumbH });
    const tempCtx = tempCanvas.getContext('2d');
    tempCtx.clearRect(0, 0, thumbW, thumbH);

    const activeLayerId = state.selectedLayerId;
    if (activeLayerId && state.canvas.activeOffscreen) {
        const activeCtx = state.canvas.activeOffscreen.getContext('2d');
        activeCtx.clearRect(0, 0, state.canvas.width, state.canvas.height);
        drawShapeToCanvasContext(activeCtx, activeLayerId);
    }

    [state.canvas.underOffscreen, state.canvas.activeOffscreen, state.canvas.overOffscreen].forEach(offscreen => {
        if (offscreen) {
            tempCtx.drawImage(offscreen, 0, 0, offscreen.width, offscreen.height, 0, 0, thumbW, thumbH);
        }
    });

    const previewBlob = await new Promise((resolve) => {
        tempCanvas.toBlob((blob) => resolve(blob), 'image/png');
    });

    const tx = db.transaction('drawings', 'readwrite');
    const store = tx.objectStore('drawings');
    const cleaned = JSON.parse(JSON.stringify({
        shapes: state.shapes,
        beziers: state.beziers,
        scene: state.scene
    }, stateReplacer));

    await store.put({
        id: state.currentDrawId,
        name: state.drawingName || 'Untitled',
        type: state.drawingType || 'canvas',
        shapes: cleaned.shapes,
        beziers: cleaned.beziers,
        scene: cleaned.scene,
        canvas: { width: state.canvas.width, height: state.canvas.height },
        preview: previewBlob,
        updatedAt: Date.now()
    });
}

/**
 * Loads all drawings from IndexedDB database and updates maximum index tracker.
 */
function loadGallery() {
    if (!db) return;
    const tx = db.transaction('drawings', 'readonly');
    const store = tx.objectStore('drawings');
    const request = store.getAll();
    request.onsuccess = () => {
        const drawings = request.result;
        let max = 0;
        for (const d of drawings) {
            if (d.id && d.id.startsWith('d')) {
                const num = parseInt(d.id.substring(1), 10);
                if (!isNaN(num) && num > max) max = num;
            }
        }
        state.maxDrawingId = max;
        renderGalleryGrid(drawings);
    };
}

/**
 * Cache list of URL Object references to clean up memory.
 * @type {Array<string>}
 */
let activeGalleryUrls = [];

/**
 * Renders gallery items cards under respective canvas, pattern, and import sections.
 * @param {Array<Object>} items - Array of drawing records retrieved from IndexedDB.
 */
function renderGalleryGrid(items) {
    const listCanvas = getDom('#gallery-list-canvas');
    const listPattern = getDom('#gallery-list-pattern');
    const listImport = getDom('#gallery-list-import');

    activeGalleryUrls.forEach(url => URL.revokeObjectURL(url));
    activeGalleryUrls = [];

    if (listCanvas) listCanvas.innerHTML = '';
    if (listPattern) listPattern.innerHTML = '';
    if (listImport) listImport.innerHTML = '';

    const template = getDom('#tmpl-gallery-card') as any;

    items.sort((a, b) => b.updatedAt - a.updatedAt).forEach(item => {
        const card = newElm('div', { className: 'gallery-card' });
        card.setAttribute('data-id', item.id);

        let imgSrc = '';
        if (item.preview) {
            if (item.preview instanceof Blob) {
                imgSrc = URL.createObjectURL(item.preview);
                activeGalleryUrls.push(imgSrc);
            } else {
                imgSrc = item.preview;
            }
        }

        if (template) {
            const clone = template.content.cloneNode(true) as any;
            
            const nameEl = clone.querySelector('.card-name');
            if (nameEl) nameEl.textContent = item.name || ('Drawing ' + item.id);
            
            const idBadge = clone.querySelector('.card-id-badge');
            if (idBadge) idBadge.textContent = item.id;

            const deleteBtn = clone.querySelector('.btn-card-delete');
            if (deleteBtn) deleteBtn.setAttribute('data-id', item.id);

            const previewEl = clone.querySelector('.card-preview');
            if (previewEl && imgSrc) {
                const img = newElm('img', { src: imgSrc, alt: 'preview' });
                previewEl.appendChild(img);
            }
            
            card.appendChild(clone);
        }

        const type = item.type || 'canvas';

        if (type === 'pattern' && listPattern) {
            listPattern.appendChild(card);
        } else if (type === 'import_image' && listImport) {
            listImport.appendChild(card);
        } else if (listCanvas) {
            listCanvas.appendChild(card);
        }
    });
}

/**
 * Deletes drawing record by key ID from storage.
 * @param {string} id - Target drawing ID to delete.
 * @param {Event} e - Click event context.
 * @returns {Promise<void>}
 */
async function deleteDrawing(id, e) {
    e.stopPropagation();
    if (!confirm('このお絵かきを削除しますか？')) return;
    const tx = db.transaction('drawings', 'readwrite');
    const store = tx.objectStore('drawings');
    await store.delete(id);
    loadGallery();
}

/**
 * Loads a specified drawing configuration from storage and launches the canvas.
 * @param {string} id - Target drawing key ID.
 */
function openDrawing(id) {
    const tx = db.transaction('drawings', 'readonly');
    const store = tx.objectStore('drawings');
    const request = store.get(id);
    request.onsuccess = () => {
        const data = request.result;
        state.currentDrawId = data.id;
        state.drawingType = data.type || 'canvas';
        state.drawingName = data.name || `Drawing ${data.id}`;
        const nameInput = getDom('#input-draw-name');
        if (nameInput) {
            nameInput.value = state.drawingName;
        }
        state.shapes = data.shapes || {};
        state.beziers = data.beziers || {};
        state.scene = data.scene || [];

        state.history = [];
        state.historyIndex = -1;

        if (data.canvas) {
            state.canvas.width = data.canvas.width || 800;
            state.canvas.height = data.canvas.height || 600;
        } else {
            state.canvas.width = 800;
            state.canvas.height = 600;
        }
        state.deformSettings = data.deformSettings || { dl: 100 };
        const widthInput = getDom('#input-canvas-width');
        const heightInput = getDom('#input-canvas-height');
        if (widthInput && heightInput) {
            widthInput.value = state.canvas.width;
            heightInput.value = state.canvas.height;
        }
        resizeOffscreenCanvases();
        syncDeformSlidersFromState();

        migrateDrawingData(state.shapes);
        initializeIdCounter();

        state.selectedLayerId = state.scene[0];

        const textureIdsToLoad = new Set() as any;
        Object.values(state.shapes).forEach(shape => {
            const s = shape as any;
            if (s && s.style) {
                if (s.style.fillPattern) textureIdsToLoad.add(s.style.fillPattern);
                if (s.style.strokePattern) textureIdsToLoad.add(s.style.strokePattern);
            }
        });

        const loadPromises = Array.from(textureIdsToLoad).map(texId => loadDrawingTexture(texId));
        Promise.all(loadPromises).then(() => {
            resolveBezierDependencies();
            clearAllCaches();
            rasterizeInactiveLayers();
            renderCanvas();
            pushHistory();
            switchView('canvas');
        });
    };
}

/**
 * Migration helper: Fixes shape properties data missing styles, widths or outlines.
 * @param {Object} shapes - Collection of Shape elements.
 */
function migrateDrawingData(shapes) {
    Object.values(shapes).forEach(shape => {
        const s = shape as any;
        if (s && s.type === 'bezier-group') {
            if (s.style) {
                if (s.style.outline === undefined) s.style.outline = true;
                if (s.style.fillEnabled === undefined) s.style.fillEnabled = true;
            } else {
                s.style = { fill: '#2196F3', opacity: 0.7, outline: true, fillEnabled: true };
            }
            if (!s.strokeWidthData) {
                s.strokeWidthData = [{ t: 0, w: 10 }, { t: 1, w: 10 }];
            }
        }
    });
}

/**
 * Helper: Resizes an image file to a thumbnail Blob representation.
 * @param {File} file - Original image file instance.
 * @param {number} maxWidth - Target maximum width boundary.
 * @param {number} maxHeight - Target maximum height boundary.
 * @returns {Promise<Blob|null>} Resolves with a Blob reference or null if failed.
 */
function resizeImageToBlob(file, maxWidth, maxHeight) {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (event) => {
            const img = new Image();
            img.onload = () => {
                let w = img.width;
                let h = img.height;
                const scale = Math.min(maxWidth / w, maxHeight / h);
                const thumbW = Math.round(w * scale);
                const thumbH = Math.round(h * scale);

                const tempCanvas = newElm('canvas', { width: thumbW, height: thumbH });
                const ctx = tempCanvas.getContext('2d');
                ctx.drawImage(img, 0, 0, thumbW, thumbH);
                tempCanvas.toBlob((blob) => {
                    resolve(blob);
                }, 'image/png');
            };
            img.onerror = () => resolve(null);
            img.src = (event.target as any).result;
        };
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(file);
    });
}

/**
 * Triggers native file import dialog to upload and store an image template.
 */
function importImageFile() {
    addClassDom('#new-draw-menu', 'hidden');
    const input = newElm('input', { type: 'file', accept: 'image/png, image/jpeg' });
    input.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        const previewBlob = await resizeImageToBlob(file, 512, 512);
        if (!previewBlob) return;

        state.maxDrawingId++;
        const newId = `d${state.maxDrawingId}`;
        const name = file.name;

        const img = await new Promise((resolve) => {
            const i = new Image();
            i.onload = () => resolve(i);
            i.onerror = () => resolve(null);
            i.src = URL.createObjectURL(file);
        }) as any;

        const width = img ? img.width : 800;
        const height = img ? img.height : 600;
        if (img) URL.revokeObjectURL(img.src);

        const tx = db.transaction('drawings', 'readwrite');
        const store = tx.objectStore('drawings');

        await store.put({
            id: newId,
            name: name,
            type: 'import_image',
            shapes: {},
            beziers: {},
            scene: [],
            canvas: { width, height },
            preview: previewBlob,
            updatedAt: Date.now()
        });

        loadGallery();
    };
    input.click();
}

/**
 * Creates a clean canvas configuration state and database slot.
 * @param {string} [type='canvas'] - The type of drawing canvas: 'canvas' or 'pattern'.
 */
function startNewDrawing(type = 'canvas') {
    addClassDom('#new-draw-menu', 'hidden');
    state.maxDrawingId++;
    state.currentDrawId = `d${state.maxDrawingId}`;
    state.drawingType = type;
    if (type === 'pattern') {
        state.drawingName = `Pattern ${state.currentDrawId}`;
    } else {
        state.drawingName = `Drawing ${state.currentDrawId}`;
    }
    const nameInput = getDom('#input-draw-name');
    if (nameInput) {
        nameInput.value = state.drawingName;
    }
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

    state.canvas.width = 800;
    state.canvas.height = 600;
    state.deformSettings = { dl: 100 };
    const widthInput = getDom('#input-canvas-width');
    const heightInput = getDom('#input-canvas-height');
    if (widthInput && heightInput) {
        widthInput.value = 800;
        heightInput.value = 600;
    }
    resizeOffscreenCanvases();
    syncDeformSlidersFromState();

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

    clearAllCaches();
    rasterizeInactiveLayers();
    renderCanvas();
    pushHistory();
    switchView('canvas');
}

/**
 * Adds a new layer in current drawing state context.
 */
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
}

/**
 * Deletes a layer and recursively strips internal shapes.
 * @param {string} layerId - Target layer ID to delete.
 */
function deleteLayer(layerId) {
    const layer = state.shapes[layerId];
    if (!layer || layer.type !== 'layer') return;

    const layerCount = state.scene.filter(sid => state.shapes[sid]?.type === 'layer').length;
    if (layerCount <= 1) {
        return;
    }

    if (!confirm(`レイヤー「${layer.name}」と内包するすべての図形を削除しますか？`)) return;

    layer.childIds.forEach(shapeId => {
        const shape = state.shapes[shapeId];
        if (shape) {
            shape.bezierIds?.forEach(bid => delete state.beziers[bid]);
            delete state.shapes[shapeId];
        }
    });

    delete state.shapes[layerId];
    state.scene = state.scene.filter(id => id !== layerId);

    if (state.selectedLayerId === layerId) {
        state.selectedLayerId = state.scene[state.scene.length - 1];
    }

    rasterizeInactiveLayers();
    renderCanvas();
    pushHistory();
}

/**
 * Renders the layers management sidebar lists.
 */
function renderLayerList() {
    const list = getDom('#layer-list');
    if (!list) return;
    list.innerHTML = '';

    const template = getDom('#tmpl-layer-item') as any;

    [...state.scene].reverse().forEach(layerId => {
        const layer = state.shapes[layerId];
        if (!layer || layer.type !== 'layer') return;

        const item = newElm('div', {
            className: `layer-item${state.selectedLayerId === layerId ? ' active' : ''}${layer.visible ? '' : ' hidden-layer'}`
        });
        item.setAttribute('data-id', layerId);

        if (template) {
            const clone = template.content.cloneNode(true) as any;
            
            const visBtn = clone.querySelector('.layer-visibility-btn');
            if (visBtn) {
                const icon = visBtn.querySelector('i');
                if (icon) {
                    icon.className = `bi ${layer.visible ? 'bi-eye' : 'bi-eye-slash'}`;
                }
            }

            const input = clone.querySelector('.layer-name-input');
            if (input) {
                input.value = layer.name;
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
            }

            item.appendChild(clone);
        }

        list.appendChild(item);
    });
}

(window as any).initDB = initDB;
(window as any).saveDrawing = saveDrawing;
(window as any).loadGallery = loadGallery;
(window as any).deleteDrawing = deleteDrawing;
(window as any).openDrawing = openDrawing;
(window as any).startNewDrawing = startNewDrawing;
(window as any).importImageFile = importImageFile;
(window as any).addLayer = addLayer;
(window as any).deleteLayer = deleteLayer;
(window as any).renderLayerList = renderLayerList;
(window as any).switchView = switchView;

export {};


