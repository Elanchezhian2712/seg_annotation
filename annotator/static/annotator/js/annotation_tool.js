document.addEventListener('DOMContentLoaded', () => {
    console.log("✅ Annotation Tool JavaScript is RUNNING!");

    // --- 1. Canvas & State Initialization ---
    const canvas = new fabric.Canvas('canvas', {
        width: window.innerWidth - 300,
        height: window.innerHeight - 50,
        backgroundColor: '#333',
        selection: true,
        fireRightClick: true,
        stopContextMenu: true,
    });

    // State Variables
    let currentTool = 'select';
    let isDrawingShape = false; 
    let activeImageId = null; 
    let currentObject = null; // Track shape being drawn

    // Helpers for shape drawing
    let origX, origY;

    // Polygon specific state
    let polygon = { active: false, points: [], lines: [], previewLine: null };

    // Pan specific state
    let isPanning = false;
    let lastPanPoint = { x: 0, y: 0 };

    // History (Undo/Redo)
    let history = [];
    let historyIndex = -1;

    // --- 2. IMAGE UPLOAD LOGIC ---
    const imageUpload = document.getElementById('image-upload');
    if (imageUpload) {
        imageUpload.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;

            const formData = new FormData();
            formData.append('image', file);

            fetch('/upload/', { method: 'POST', body: formData })
            .then(response => response.json())
            .then(data => {
                if (data.error) { alert("Server Error: " + data.error); return; }
                
                console.log("✅ Image uploaded. ID:", data.id);
                activeImageId = data.id; // SAVE THIS ID!
                
                fabric.Image.fromURL(data.url, (img) => {
                    if (!img) return;
                    canvas.setBackgroundImage(img, canvas.renderAll.bind(canvas), {
                        scaleX: canvas.width / img.width,
                        scaleY: canvas.height / img.height,
                        originX: 'left', originY: 'top'
                    });
                    // Reset history
                    history = []; historyIndex = -1;
                    saveState(); 
                });
            })
            .catch(err => console.error("❌ Upload Error:", err));
        });
    }

    // --- 3. ROBUST SAVE LOGIC (FIXED) ---
    const saveBtn = document.getElementById('save-annotations');
    if (saveBtn) {
        saveBtn.addEventListener('click', () => {
            console.log("💾 Save Clicked. Active Image ID:", activeImageId);

            if (!activeImageId) { 
                alert("⚠️ No image selected! Please upload an image first."); 
                return; 
            }

            // Filter Logic:
            // 1. Exclude Background Images (type === 'image')
            // 2. Exclude Temporary Guides (evented === false). 
            //    (Polygon red dots/lines are created with evented:false)
            const objects = canvas.getObjects().filter(obj => {
                return obj.type !== 'image' && obj.evented !== false;
            });
            
            console.log(`🔍 Found ${objects.length} objects to save.`);

            const annotations = objects.map(obj => {
                // Common properties
                let objData = {
                    type: obj.type,
                    left: obj.left, 
                    top: obj.top,
                    width: obj.width * obj.scaleX,
                    height: obj.height * obj.scaleY,
                    fill: obj.fill, 
                    stroke: obj.stroke,
                    label: obj.label || 'untitled',
                    class: obj.class || 'default'
                };

                // Type-specific properties
                if (obj.type === 'polygon') {
                    objData.points = obj.points;
                }
                if (obj.type === 'circle') {
                    objData.radius = obj.radius * obj.scaleX;
                }
                if (obj.type === 'path') { // For Brush strokes
                    objData.path = obj.path; 
                }

                return objData;
            });

            // Send to Backend
            fetch(`/save/${activeImageId}/`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ annotations: annotations })
            })
            .then(res => res.json())
            .then(data => {
                if (data.success) alert("✅ Annotations Saved Successfully!");
                else alert("❌ Save Failed: " + data.error);
            })
            .catch(err => console.error("❌ Save Request Failed:", err));
        });
    }

    // --- 4. Tool Selection ---
    const brushOptions = document.getElementById('brush-options');
    const brushSizeInput = document.getElementById('brush-size');
    const brushColorInput = document.getElementById('brush-color');

    function setActiveTool(toolName) {
        currentTool = toolName;
        
        document.querySelectorAll('.tool-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tool === toolName);
        });

        canvas.isDrawingMode = false;
        canvas.selection = toolName === 'select';
        canvas.defaultCursor = toolName === 'select' ? 'default' : 'crosshair';
        
        // Lock/Unlock selection based on tool
        canvas.forEachObject(obj => obj.set({ selectable: toolName === 'select' }));
        canvas.discardActiveObject().renderAll();

        if (brushOptions) {
            brushOptions.classList.toggle('hidden', !['brush', 'eraser'].includes(toolName));
        }

        // Reset polygon mode if switching away
        if (toolName !== 'polygon' && polygon.active) resetPolygonDrawing();

        // Brush Logic
        if (toolName === 'brush') {
            canvas.isDrawingMode = true;
            canvas.freeDrawingBrush = new fabric.PencilBrush(canvas);
            canvas.freeDrawingBrush.width = parseInt(brushSizeInput.value, 10) || 10;
            canvas.freeDrawingBrush.color = brushColorInput.value || '#ff0000';
        } else if (toolName === 'eraser') {
            canvas.isDrawingMode = true;
            canvas.freeDrawingBrush = new fabric.PencilBrush(canvas);
            canvas.freeDrawingBrush.width = 30;
            canvas.freeDrawingBrush.color = '#333333'; // Match background
        }
    }

    document.querySelectorAll('.tool-btn').forEach(btn => {
        btn.addEventListener('click', () => setActiveTool(btn.dataset.tool));
    });

    if(brushSizeInput) brushSizeInput.addEventListener('input', (e) => { if(canvas.isDrawingMode) canvas.freeDrawingBrush.width = parseInt(e.target.value, 10); });
    if(brushColorInput) brushColorInput.addEventListener('input', (e) => { if(canvas.isDrawingMode) canvas.freeDrawingBrush.color = e.target.value; });


    // --- 5. Canvas Interaction (Drawing) ---
    canvas.on('mouse:down', (opt) => {
        const pointer = canvas.getPointer(opt.e);
        const activeColor = brushColorInput ? brushColorInput.value : '#ff0000';

        // Pan Mode
        if (currentTool === 'pan' || (opt.e.altKey || opt.e.button === 1)) { 
            isPanning = true; 
            lastPanPoint = { x: opt.e.clientX, y: opt.e.clientY };
            canvas.defaultCursor = 'grabbing';
            return;
        }

        // Polygon Mode
        if (currentTool === 'polygon') {
            if (polygon.active) {
                if (opt.e.button === 2) finalizePolygon(); // Right click to finish
                else addPolygonPoint(pointer);
            } else {
                startPolygon(pointer);
            }
            return;
        }

        // Rectangle Mode
        if (currentTool === 'rectangle') {
            isDrawingShape = true;
            origX = pointer.x;
            origY = pointer.y;
            
            const rect = new fabric.Rect({
                left: origX, top: origY,
                originX: 'left', originY: 'top',
                width: 0, height: 0,
                fill: activeColor + '80', 
                stroke: activeColor, strokeWidth: 2,
                transparentCorners: false, label: 'Rect'
            });
            canvas.add(rect);
            canvas.setActiveObject(rect);
            currentObject = rect;
        }

        // Circle Mode
        if (currentTool === 'circle') {
            isDrawingShape = true;
            origX = pointer.x;
            origY = pointer.y;
            
            const circle = new fabric.Circle({
                left: origX, top: origY,
                originX: 'left', originY: 'top',
                radius: 0,
                fill: activeColor + '80', 
                stroke: activeColor, strokeWidth: 2,
                transparentCorners: false, label: 'Circle'
            });
            canvas.add(circle);
            canvas.setActiveObject(circle);
            currentObject = circle;
        }
    });

    canvas.on('mouse:move', (opt) => {
        const pointer = canvas.getPointer(opt.e);

        if (isPanning) {
            const dx = opt.e.clientX - lastPanPoint.x;
            const dy = opt.e.clientY - lastPanPoint.y;
            canvas.relativePan(new fabric.Point(dx, dy));
            lastPanPoint = { x: opt.e.clientX, y: opt.e.clientY };
            return;
        }

        if (isDrawingShape && currentObject) {
            if (currentTool === 'rectangle') {
                if(origX > pointer.x) currentObject.set({ left: Math.abs(pointer.x) });
                if(origY > pointer.y) currentObject.set({ top: Math.abs(pointer.y) });
                currentObject.set({ width: Math.abs(origX - pointer.x) });
                currentObject.set({ height: Math.abs(origY - pointer.y) });
            }
            if (currentTool === 'circle') {
                const radius = Math.abs(origX - pointer.x) / 2;
                currentObject.set({ radius: radius });
                if(origX > pointer.x) currentObject.set({left: pointer.x});
            }
            canvas.renderAll();
        }

        if (polygon.active && polygon.previewLine) {
            polygon.previewLine.set({ x2: pointer.x, y2: pointer.y }).setCoords();
            canvas.renderAll();
        }
    });

    canvas.on('mouse:up', () => {
        isPanning = false;
        if (isDrawingShape) {
            isDrawingShape = false;
            if (currentObject) {
                currentObject.setCoords();
                // Remove tiny objects created by accident
                if (currentObject.width < 5 && currentObject.radius < 3) {
                    canvas.remove(currentObject);
                } else {
                    saveState();
                    updateLayersList();
                }
            }
        }
        canvas.defaultCursor = currentTool === 'select' ? 'default' : 'crosshair';
    });

    // --- 6. Polygon Helpers ---
    function startPolygon(pointer) {
        polygon.active = true;
        polygon.points.push({ x: pointer.x, y: pointer.y });
        // Guides (evented: false means they won't be saved)
        const circle = new fabric.Circle({ radius: 3, fill: 'red', left: pointer.x, top: pointer.y, originX: 'center', originY: 'center', selectable: false, evented: false });
        polygon.lines.push(circle); canvas.add(circle);
        polygon.previewLine = new fabric.Line([pointer.x, pointer.y, pointer.x, pointer.y], { stroke: 'red', strokeWidth: 1, selectable: false, evented: false });
        canvas.add(polygon.previewLine);
    }
    function addPolygonPoint(pointer) {
        const lastPoint = polygon.points[polygon.points.length - 1];
        polygon.points.push({ x: pointer.x, y: pointer.y });
        const line = new fabric.Line([lastPoint.x, lastPoint.y, pointer.x, pointer.y], { stroke: 'red', strokeWidth: 2, selectable: false, evented: false });
        polygon.lines.push(line); canvas.add(line);
        polygon.previewLine.set({ x1: pointer.x, y1: pointer.y }).setCoords();
        canvas.renderAll();
    }
    function finalizePolygon() {
        if (!polygon.active || polygon.points.length < 3) { resetPolygonDrawing(); return; }
        const finalPolygon = new fabric.Polygon(polygon.points, {
            fill: (brushColorInput.value || '#ff0000') + '80',
            stroke: brushColorInput.value || '#ff0000', strokeWidth: 2, objectCaching: false, label: 'Polygon'
        });
        canvas.add(finalPolygon); resetPolygonDrawing(); updateLayersList(); saveState(); setActiveTool('select');
    }
    function resetPolygonDrawing() {
        polygon.active = false; 
        polygon.lines.forEach(obj => canvas.remove(obj)); 
        canvas.remove(polygon.previewLine);
        polygon.points = []; polygon.lines = []; polygon.previewLine = null; 
        canvas.renderAll();
    }

    // --- 7. History & Layers ---
    function saveState() {
        if (polygon.active) return;
        const json = canvas.toJSON(['label', 'class', 'id']);
        if(historyIndex < history.length - 1) history = history.slice(0, historyIndex + 1);
        history.push(json); historyIndex = history.length - 1;
    }
    function undo() { if(historyIndex > 0) { historyIndex--; canvas.loadFromJSON(history[historyIndex], () => { canvas.renderAll(); updateLayersList(); }); } }
    function redo() { if(historyIndex < history.length - 1) { historyIndex++; canvas.loadFromJSON(history[historyIndex], () => { canvas.renderAll(); updateLayersList(); }); } }

    function updateLayersList() {
        const layersList = document.getElementById('layers-list');
        if(!layersList) return;
        layersList.innerHTML = '';
        // Filter guides out of layer list too
        const objects = canvas.getObjects().filter(obj => obj.evented !== false && obj.type !== 'image').slice().reverse();
        
        objects.forEach((obj, index) => {
            const li = document.createElement('li');
            li.className = 'layer-item';
            li.innerHTML = `
                <input type="color" class="layer-color" value="${obj.stroke || '#ff0000'}">
                <span class="layer-label" contenteditable="true">${obj.label || obj.type}</span>
                <button class="btn-delete"><i class="fa-solid fa-trash-can"></i></button>
            `;
            li.querySelector('.layer-color').addEventListener('input', (e) => { obj.set('stroke', e.target.value); obj.set('fill', e.target.value + '80'); canvas.renderAll(); });
            li.querySelector('.layer-label').addEventListener('blur', (e) => { obj.set('label', e.target.textContent); });
            li.querySelector('.btn-delete').addEventListener('click', () => { canvas.remove(obj); updateLayersList(); saveState(); });
            layersList.appendChild(li);
        });
    }

    // --- 8. Initial Setup ---
    window.addEventListener('resize', () => { canvas.setWidth(window.innerWidth - 300); canvas.setHeight(window.innerHeight - 50); });
    window.addEventListener('keydown', (e) => {
        if (['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
        if(e.key.toLowerCase() === 'v') setActiveTool('select');
        if(e.key.toLowerCase() === 'p') setActiveTool('polygon');
        if(e.key.toLowerCase() === 'r') setActiveTool('rectangle');
        if(e.key.toLowerCase() === 'c') setActiveTool('circle');
        if(e.ctrlKey && e.key === 'z') undo();
        if(e.key === 'Delete') { 
            canvas.getActiveObjects().forEach(obj => canvas.remove(obj)); 
            canvas.discardActiveObject().renderAll(); updateLayersList(); saveState(); 
        }
        if(e.key === 'Enter' && polygon.active) finalizePolygon();
    });

    setActiveTool('select');
    saveState();
});