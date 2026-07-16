/**
 * @file main.ts
 * @description Entry point for MorphDraw. Binds top-level event listeners (pointer, window, keyboard, DOM) and initializes the IndexedDB store.
 */

import './mdmath';
import './webgl_renderer';
import './state';
import './db';
import './history';
import './renderer';
import './editor';
import './test';
import './style.css';



document.addEventListener('DOMContentLoaded', () => {
    initDB();
    initOffscreenCanvases();
    initEvents();
});

/**
 * Binds DOM elements actions, window resize triggers, pointer movements, and keyboard events onto editor handler pipelines.
 */
function initEvents() {

    getDom('#btn-back-gallery').onclick = async () => {
        await saveDrawing();
        loadGallery();
        switchView('gallery');
    };

    getDom('#btn-toggle-minimap').onclick = () => {
        const panel = getDom('#minimap-panel');
        panel.classList.toggle('collapsed');
        const icon = getDom('#btn-toggle-minimap i');
        if (icon) {
            const isCollapsed = panel.classList.contains('collapsed');
            icon.className = `bi ${isCollapsed ? 'bi-chevron-double-left' : 'bi-chevron-double-right'}`;
        }
    };

    document.body.onclick = (event) => {
        handleInputUpdate(event);
    };

    const svg = getDom('#guide-svg');
    const minimapCanvas = getDom('#minimap-canvas');

    svg.addEventListener('pointerdown', (e) => {
        const startPt = getMainCanvasSVGPoint();
        state.input.isPointerDown = true;
        state.input.dragStartOnSVG = startPt;
        handleInputUpdate_old('pointerdown');
        handleInputUpdate(e);
    });

    window.addEventListener('wheel', (event) => {
        state.input.modifier = getModifierState(event);
        state.input.deltaY = event.deltaY;
        handleInputUpdate(event);
        event.preventDefault();
    }, { passive: false });

    if (minimapCanvas) {
        minimapCanvas.addEventListener('pointerdown', (e) => {
            state.input.isPointerDown = true;
            const pt = getMainCanvasSVGPoint();
            state.input.dragStartOnSVG = pt;
            handleInputUpdate_old('pointerdown');
            handleInputUpdate(e);
        });
    }

    window.addEventListener('pointermove', (e) => {
        if (state.view === 'canvas') {
            state.input.dPointer = { x: e.clientX - state.input.pointer.x, y: e.clientY - state.input.pointer.y };
            state.input.pointer = { x: e.clientX, y: e.clientY };

            const pt = getMainCanvasSVGPoint();
            state.input.pointerOnSVG = { x: pt.x, y: pt.y };

            handleInputUpdate_old('pointermove');
            handleInputUpdate(e);
        }
    });

    const stop = (e) => {
        state.input.isPointerDown = false;
        state.input.dragStartOnSVG = null;
        handleInputUpdate_old('pointerup');
        handleInputUpdate(e);
    };
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);

    window.addEventListener('keydown', async e => {
        if (e.repeat) return;
        if (isFocusEditable()) return;
        state.input.keys[e.key] = true;
        await handleInputUpdate_old('keydown', e.key, e);
        await handleInputUpdate(e);
    });

    window.addEventListener('keyup', async e => {
        if (isFocusEditable()) return;
        state.input.keys[e.key] = false;
        await handleInputUpdate_old('keyup', e.key, e);
        await handleInputUpdate(e);
    });

    getDom('#btn-toggle-settings').onclick = () => {
        const panel = getDom('#settings-panel');
        if (panel) {
            panel.classList.toggle('collapsed');
        }
    };

    getDoms('.settings-tab-btn').forEach(btn => {
        btn.onclick = () => {
            const tabName = btn.getAttribute('data-tab');
            switchSettingsTab(tabName);
        };
    });

    const drawNameInput = getDom('#input-draw-name');
    if (drawNameInput) {
        drawNameInput.onkeydown = (e) => {
            if (e.key === 'Enter') {
                const btn = getDom('#btn-save-image-settings');
                if (btn) btn.click();
                drawNameInput.blur();
            }
        };
    }

    const btnSaveImageSettings = getDom('#btn-save-image-settings');
    if (btnSaveImageSettings) {
        btnSaveImageSettings.onclick = () => {
            const nameInput = getDom('#input-draw-name');
            const widthInput = getDom('#input-canvas-width');
            const heightInput = getDom('#input-canvas-height');

            let changed = false;

            if (nameInput && nameInput.value.trim() !== '') {
                const newName = nameInput.value.trim();
                if (newName !== state.drawingName) {
                    state.drawingName = newName;
                    changed = true;
                }
            }

            if (widthInput && heightInput) {
                const w = parseInt(widthInput.value, 10);
                const h = parseInt(heightInput.value, 10);
                if (w > 0 && h > 0 && (w !== state.canvas.width || h !== state.canvas.height)) {
                    state.canvas.width = w;
                    state.canvas.height = h;
                    resizeOffscreenCanvases();
                    clearAllCaches();
                    rasterizeInactiveLayers();
                    changed = true;
                }
            }

            if (changed) {
                saveDrawing();
                pushHistory();
                renderCanvas();
            }
        };
    }

    const centerSlider = getDom('#slider-sigma-center');
    if (centerSlider) {
        centerSlider.oninput = () => {
            const val = parseInt(centerSlider.value, 10);
            state.deformSettings.sigmaCenter = val;
            const label = getDom('#val-sigma-center');
            if (label) label.textContent = String(val);
        };
        centerSlider.onchange = () => {
            saveDrawing();
        };
    }

    const distSlider = getDom('#slider-sigma-dist');
    if (distSlider) {
        distSlider.oninput = () => {
            const val = parseInt(distSlider.value, 10);
            state.deformSettings.sigmaDist = val;
            const label = getDom('#val-sigma-dist');
            if (label) label.textContent = String(val);
        };
        distSlider.onchange = () => {
            saveDrawing();
        };
    }

    const decayRadios = document.getElementsByName('deform-decay-mode');
    decayRadios.forEach(radio => {
        radio.onchange = (e) => {
            state.deformSettings.deformDecayMode = (e.target as any).value;
            saveDrawing();
        };
    });

    getDom('#btn-add-layer').onclick = () => {
        addLayer();
    };

    const searchInput = getDom('#search-input');
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

    const commandInput = getDom('#command-input');
    if (commandInput) {
        commandInput.onkeydown = (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                closeCommandMode(true);
            } else if (e.key === 'Escape') {
                e.preventDefault();
                closeCommandMode(false);
            }
        };
        commandInput.onblur = () => {
            setTimeout(() => {
                if (state.command.active) {
                    closeCommandMode(false);
                }
            }, 200);
        };
    }

    if (svg) registerHoverListener(svg);
    if (minimapCanvas) registerHoverListener(minimapCanvas);
}

/**
 * Registers mouseenter and mouseleave event listeners to track which canvas/SVG element the user is hovering over.
 * @param {Element} elm - The target DOM element.
 */
function registerHoverListener(elm) {
    elm.addEventListener('mouseenter', () => {
        state.input.hoverOn = elm.id;
    });
    elm.addEventListener('mouseleave', () => {
        state.input.hoverOn = '';
    });
}
