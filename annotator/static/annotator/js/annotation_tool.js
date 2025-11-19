document.addEventListener('DOMContentLoaded', () => {
    console.log("✅ Annotation Tool JavaScript is RUNNING!");

    // --- 1. Canvas & State Initialization ---
    const canvas = new fabric.Canvas('canvas', {
        width: window.innerWidth - 300, // Adjust based on your sidebar width
        height: window.innerHeight - 50,
        backgroundColor: '#333',
        selection: true,
        fireRightClick: true,
        stopContextMenu: true,
    });

    // State Variables
    let currentTool = 'select';
    let isDrawing = false;
    let currentObject = null;
    let history = [];
    let historyIndex = -1;

    // Polygon specific state
    let polygon = { active: false, points: [], lines: [], previewLine: null };

    // Pan specific state
    let isPanning = false;
    let lastPanPoint = { x: 0, y: 0 };

    // --- 2. THE FIXED IMAGE UPLOAD LOGIC (CRITICAL) ---
    const imageUpload = document.getElementById('image-upload');

    if (!imageUpload) {
        console.error("❌ ERROR: Could not find element with id 'image-upload'!");
    } else {
        imageUpload.addEventListener('change', (e) => {
            console.log("🖱️ User selected a file.");
            const file = e.target.files[0];
            if (!file) return;

            const formData = new FormData();
            formData.append('image', file);

            fetch('/upload/', {
                method: 'POST',
                body: formData,
            })
            .then(response => response.json())
            .then(data => {
                if (data.error) {
                    alert("Server Error: " + data.error);
                    return;
                }

                console.log("✅ Image URL received:", data.url);

                // Load Image onto Canvas
                fabric.Image.fromURL(data.url, (img) => {
                    if (!img) {
                        alert("Error loading image to canvas");
                        return;
                    }

                    console.log("🖼️ Image loaded on canvas!");
                    
                    // Set as background
                    canvas.setBackgroundImage(img, canvas.renderAll.bind(canvas), {
                        scaleX: canvas.width / img.width,
                        scaleY: canvas.height / img.height,
                        originX: 'left',
                        originY: 'top'
                    });

                    // Reset history on new image load
                    history = [];
                    historyIndex = -1;
                    saveState(); 
                });
            })
            .catch(err => console.error("❌ Fetch Error:", err));
        });
    }

    // --- 3. Tool Selection & UI References ---
    const brushOptions = document.getElementById('brush-options');
    const brushSizeInput = document.getElementById('brush-size');
    const brushSizeLabel = document.getElementById('brush-size-label');
    const brushColorInput = document.getElementById('brush-color');

    function setActiveTool(toolName) {
        currentTool = toolName;
        console.log(`Tool switched to: ${toolName}`);
        
        document.querySelectorAll('.tool-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tool === toolName);
        });

        canvas.isDrawingMode = false;
        canvas.selection = toolName === 'select';
        canvas.defaultCursor = toolName === 'select' ? 'default' : 'crosshair';
        
        // Lock/Unlock selection based on tool
        canvas.forEachObject(obj => obj.set({ selectable: toolName === 'select' }));
        canvas.discardActiveObject().renderAll();

        // Show/hide brush options
        if (brushOptions) {
            brushOptions.classList.toggle('hidden', !['brush', 'eraser'].includes(toolName));
        }

        // Reset polygon mode if we were using it
        if (toolName !== 'polygon' && polygon.active) {
            resetPolygonDrawing();
        }

        // Setup Brush/Eraser
        if (toolName === 'brush') {
            canvas.isDrawingMode = true;
            canvas.freeDrawingBrush = new fabric.PencilBrush(canvas);
            canvas.freeDrawingBrush.width = parseInt(brushSizeInput.value, 10) || 10;
            canvas.freeDrawingBrush.color = brushColorInput.value || '#ff0000';
        } else if (toolName === 'eraser') {
            canvas.isDrawingMode = true;
            // Fabric.js doesn't have a default EraserBrush in all versions, 
            // usually we simulate it by drawing with background color or specific logic.
            // For now, we treat it as a white brush (simple eraser)
            canvas.freeDrawingBrush = new fabric.PencilBrush(canvas);
            canvas.freeDrawingBrush.width = (parseInt(brushSizeInput.value, 10) || 10) * 2;
            canvas.freeDrawingBrush.color = '#333333'; // Match bg color
        }
    }

    // Tool Button Listeners
    document.querySelectorAll('.tool-btn').forEach(btn => {
        btn.addEventListener('click', () => setActiveTool(btn.dataset.tool));
    });

    // Brush Options Listeners
    if (brushSizeInput) {
        brushSizeInput.addEventListener('input', (e) => {
            if(brushSizeLabel) brushSizeLabel.textContent = e.target.value;
            if (canvas.isDrawingMode) {
                canvas.freeDrawingBrush.width = parseInt(e.target.value, 10);
            }
        });
    }
    if (brushColorInput) {
        brushColorInput.addEventListener('input', (e) => {
            if (canvas.isDrawingMode) {
                canvas.freeDrawingBrush.color = e.target.value;
            }
        });
    }

    // --- 4. Zoom and Pan Logic ---
    canvas.on('mouse:wheel', function(opt) {
        const delta = opt.e.deltaY;
        let zoom = canvas.getZoom();
        zoom *= 0.999 ** delta;
        if (zoom > 20) zoom = 20;
        if (zoom < 0.1) zoom = 0.1;
        canvas.zoomToPoint({ x: opt.e.offsetX, y: opt.e.offsetY }, zoom);
        opt.e.preventDefault();
        opt.e.stopPropagation();
    });

    const btnZoomIn = document.getElementById('zoom-in');
    const btnZoomOut = document.getElementById('zoom-out');
    const btnFit = document.getElementById('fit-to-screen');

    if(btnZoomIn) btnZoomIn.addEventListener('click', () => canvas.setZoom(canvas.getZoom() * 1.1));
    if(btnZoomOut) btnZoomOut.addEventListener('click', () => canvas.setZoom(canvas.getZoom() * 0.9));
    if(btnFit) btnFit.addEventListener('click', () => {
        canvas.setZoom(1);
        canvas.viewportTransform = [1, 0, 0, 1, 0, 0];
    });

    // --- 5. History (Undo/Redo) ---
    function saveState() {
        // Skip saving state if we are just dragging polygon temp lines
        if (polygon.active) return;

        // Serialize canvas
        const json = canvas.toJSON(['label', 'class', 'id']);
        
        // Remove future history if we were in the middle
        if(historyIndex < history.length - 1) {
            history = history.slice(0, historyIndex + 1);
        }
        
        history.push(json);
        historyIndex = history.length - 1;
    }

    function undo() {
        if (historyIndex > 0) {
            historyIndex--;
            canvas.loadFromJSON(history[historyIndex], () => {
                canvas.renderAll();
                updateLayersList();
            });
        }
    }

    function redo() {
        if (historyIndex < history.length - 1) {
            historyIndex++;
            canvas.loadFromJSON(history[historyIndex], () => {
                canvas.renderAll();
                updateLayersList();
            });
        }
    }

    const btnUndo = document.getElementById('undo');
    const btnRedo = document.getElementById('redo');
    if(btnUndo) btnUndo.addEventListener('click', undo);
    if(btnRedo) btnRedo.addEventListener('click', redo);

    // --- 6. Canvas Interaction (Drawing/Events) ---
    canvas.on('mouse:down', (opt) => {
        const pointer = canvas.getPointer(opt.e);
        lastPanPoint = { x: opt.e.clientX, y: opt.e.clientY };

        // Pan Mode
        if (currentTool === 'pan' || (opt.e.altKey || opt.e.button === 1)) { 
            isPanning = true;
            canvas.defaultCursor = 'grabbing';
            return;
        }

        // Polygon Mode
        if (currentTool === 'polygon') {
            if (polygon.active) {
                if (opt.e.button === 2) { // Right-click
                    finalizePolygon();
                } else {
                    addPolygonPoint(pointer);
                }
            } else {
                startPolygon(pointer);
            }
        }
        
        // Rectangle/Circle Mode could be added here (using simple click-drag logic)
    });

    canvas.on('mouse:move', (opt) => {
        // Panning
        if (isPanning) {
            const dx = opt.e.clientX - lastPanPoint.x;
            const dy = opt.e.clientY - lastPanPoint.y;
            canvas.relativePan(new fabric.Point(dx, dy));
            lastPanPoint = { x: opt.e.clientX, y: opt.e.clientY };
            return;
        }

        // Polygon Preview Line
        if (polygon.active) {
            const pointer = canvas.getPointer(opt.e);
            if(polygon.previewLine) {
                polygon.previewLine.set({ x2: pointer.x, y2: pointer.y });
                polygon.previewLine.setCoords();
                canvas.renderAll();
            }
        }
    });

    canvas.on('mouse:up', () => {
        isPanning = false;
        canvas.defaultCursor = currentTool === 'select' ? 'default' : 'crosshair';
        
        // Save state if we modified an object (not while drawing polygon)
        if (!polygon.active && !isPanning) {
            // We can add a check here to see if something actually changed
        }
    });

    canvas.on('object:modified', saveState);
    canvas.on('object:added', (e) => {
        // Don't save state for temporary polygon lines
        if (e.target && !e.target.selectable && currentTool === 'polygon') return;
        saveState();
    });
    canvas.on('object:removed', saveState);


    // --- 7. Polygon Logic ---
    function startPolygon(pointer) {
        polygon.active = true;
        polygon.points.push({ x: pointer.x, y: pointer.y });
        
        // Visual feedback (Point)
        const circle = new fabric.Circle({
            radius: 3, fill: 'red', left: pointer.x, top: pointer.y,
            originX: 'center', originY: 'center', selectable: false, evented: false,
        });
        polygon.lines.push(circle); 
        canvas.add(circle);

        // Preview line
        polygon.previewLine = new fabric.Line([pointer.x, pointer.y, pointer.x, pointer.y], {
            stroke: 'red', strokeWidth: 1, selectable: false, evented: false,
        });
        canvas.add(polygon.previewLine);
    }

    function addPolygonPoint(pointer) {
        const lastPoint = polygon.points[polygon.points.length - 1];
        polygon.points.push({ x: pointer.x, y: pointer.y });

        // Permanent line segment
        const line = new fabric.Line([lastPoint.x, lastPoint.y, pointer.x, pointer.y], {
            stroke: 'red', strokeWidth: 2, selectable: false, evented: false,
        });
        polygon.lines.push(line);
        canvas.add(line);

        // Reset preview line
        polygon.previewLine.set({ x1: pointer.x, y1: pointer.y }).setCoords();
        canvas.renderAll();
    }

    function finalizePolygon() {
        if (!polygon.active || polygon.points.length < 3) {
            resetPolygonDrawing();
            return;
        }

        // Create final shape
        const finalPolygon = new fabric.Polygon(polygon.points, {
            fill: (brushColorInput.value || '#ff0000') + '80',
            stroke: brushColorInput.value || '#ff0000',
            strokeWidth: 2,
            objectCaching: false,
            id: `poly_${Date.now()}`,
            label: 'New Polygon',
            class: 'default'
        });

        canvas.add(finalPolygon);
        resetPolygonDrawing();
        updateLayersList();
        saveState(); 
        setActiveTool('select'); // Auto-switch to select mode
    }

    function resetPolygonDrawing() {
        polygon.active = false;
        polygon.lines.forEach(obj => canvas.remove(obj));
        canvas.remove(polygon.previewLine);
        polygon.points = [];
        polygon.lines = [];
        polygon.previewLine = null;
        canvas.renderAll();
    }


    // --- 8. Layer Management ---
    function updateLayersList() {
        const layersList = document.getElementById('layers-list');
        if(!layersList) return;

        layersList.innerHTML = '';
        // Get valid objects (exclude temp guides)
        const objects = canvas.getObjects().filter(obj => obj.selectable).slice().reverse();

        objects.forEach((obj, index) => {
            const li = document.createElement('li');
            li.className = 'layer-item';
            
            // Layer HTML
            li.innerHTML = `
                <input type="color" class="layer-color" value="${obj.stroke || '#ff0000'}">
                <span class="layer-label" contenteditable="true">${obj.label || 'Object ' + (index+1)}</span>
                <div class="layer-controls">
                    <button class="btn-visible"><i class="fa-solid fa-eye"></i></button>
                    <button class="btn-delete"><i class="fa-solid fa-trash-can"></i></button>
                </div>
            `;

            // Color Change
            li.querySelector('.layer-color').addEventListener('input', (e) => {
                obj.set('stroke', e.target.value);
                obj.set('fill', e.target.value + '80');
                canvas.renderAll();
            });

            // Label Rename
            li.querySelector('.layer-label').addEventListener('blur', (e) => {
                obj.set('label', e.target.textContent);
            });

            // Delete
            li.querySelector('.btn-delete').addEventListener('click', () => {
                canvas.remove(obj);
                updateLayersList();
                saveState();
            });

            // Visibility
            li.querySelector('.btn-visible').addEventListener('click', (e) => {
                obj.set('visible', !obj.visible);
                canvas.renderAll();
                e.currentTarget.innerHTML = obj.visible ? '<i class="fa-solid fa-eye"></i>' : '<i class="fa-solid fa-eye-slash"></i>';
            });

            layersList.appendChild(li);
        });
    }

    // --- 9. Keyboard Shortcuts ---
    window.addEventListener('keydown', (e) => {
        // Ignore if typing in a text field
        if (['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName) || document.activeElement.isContentEditable) {
            return;
        }

        // Tools
        if (e.key.toLowerCase() === 'v') setActiveTool('select');
        if (e.key.toLowerCase() === 'h') setActiveTool('pan');
        if (e.key.toLowerCase() === 'p') setActiveTool('polygon');
        if (e.key.toLowerCase() === 'b') setActiveTool('brush');
        if (e.key.toLowerCase() === 'e') setActiveTool('eraser');

        // Undo/Redo
        if (e.ctrlKey && e.key === 'z') { e.preventDefault(); undo(); }
        if (e.ctrlKey && e.key === 'y') { e.preventDefault(); redo(); }

        // Delete
        if (e.key === 'Delete' || e.key === 'Backspace') {
            const activeObjects = canvas.getActiveObjects();
            if (activeObjects.length) {
                activeObjects.forEach(obj => canvas.remove(obj));
                canvas.discardActiveObject().renderAll();
                updateLayersList();
                saveState();
            }
        }

        // Enter to finish polygon
        if (e.key === 'Enter' && polygon.active) finalizePolygon();
    });

    // --- 10. Window Resize ---
    window.addEventListener('resize', () => {
        canvas.setWidth(window.innerWidth - 300);
        canvas.setHeight(window.innerHeight - 50);
    });

    // --- 11. Initial Setup ---
    setActiveTool('select');
    saveState();
});