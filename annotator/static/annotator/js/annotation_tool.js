document.addEventListener("DOMContentLoaded", () => {
  console.log("✅ Annotation Tool JavaScript is RUNNING!");

  // --- 1. Canvas & State Initialization ---
  const canvas = new fabric.Canvas("canvas", {
    width: window.innerWidth - 300,
    height: window.innerHeight - 50,
    backgroundColor: "#222",
    selection: true,
    fireRightClick: true,
    stopContextMenu: true,
  });

  // Fix focus for shortcuts
  const container = document.querySelector('.canvas-container');
  if (container) {
      container.tabIndex = 1;
      container.style.outline = 'none';
      container.focus();
  }

  // Global Variables
  let currentTool = "select";
  let isDrawingShape = false;
  let activeImageId = null;
  let currentObject = null;
  let currentImageScale = { x: 1, y: 1 }; 

  // Drawing Helpers
  let origX, origY;
  let polygon = { active: false, points: [], lines: [], previewLine: null };
  let isPanning = false;
  let lastPanPoint = { x: 0, y: 0 };
  let history = [];
  let historyIndex = -1;

  // --- 2. TOOL SELECTION LOGIC (THE FIX IS HERE) ---
  const brushOptions = document.getElementById('brush-options');
  const brushSizeInput = document.getElementById('brush-size');
  const brushColorInput = document.getElementById('brush-color');

  // This function was missing in your code!
  function setActiveTool(toolName) {
      currentTool = toolName;
      console.log(`Tool switched to: ${toolName}`);
      
      // 1. Update UI Buttons
      document.querySelectorAll('.tool-btn').forEach(btn => {
          btn.classList.toggle('active', btn.dataset.tool === toolName);
      });

      // 2. Reset Canvas State
      canvas.isDrawingMode = false;
      canvas.selection = toolName === 'select';
      canvas.defaultCursor = toolName === 'select' ? 'default' : 'crosshair';
      
      // 3. Lock/Unlock selection based on tool
      canvas.forEachObject(obj => obj.set({ selectable: toolName === 'select' }));
      canvas.discardActiveObject().renderAll();

      // 4. Toggle Brush Options UI
      if (brushOptions) {
          brushOptions.classList.toggle('hidden', !['brush', 'eraser'].includes(toolName));
      }

      // 5. Reset Polygon logic if we were using it
      if (toolName !== 'polygon' && polygon.active) {
          resetPolygonDrawing();
      }

      // 6. Configure Brush/Eraser
      if (toolName === 'brush') {
          canvas.isDrawingMode = true;
          canvas.freeDrawingBrush = new fabric.PencilBrush(canvas);
          const size = brushSizeInput ? parseInt(brushSizeInput.value, 10) : 10;
          const color = brushColorInput ? brushColorInput.value : '#ff0000';
          canvas.freeDrawingBrush.width = size;
          canvas.freeDrawingBrush.color = color;
      } else if (toolName === 'eraser') {
          canvas.isDrawingMode = true;
          canvas.freeDrawingBrush = new fabric.PencilBrush(canvas);
          canvas.freeDrawingBrush.width = 30;
          canvas.freeDrawingBrush.color = '#222'; // Eraser matches background
      }
  }

  // Attach Click Listeners
  document.querySelectorAll('.tool-btn').forEach(btn => {
      btn.addEventListener('click', () => setActiveTool(btn.dataset.tool));
  });

  // Attach Brush Input Listeners
  if(brushSizeInput) brushSizeInput.addEventListener('input', (e) => { 
      if(canvas.isDrawingMode) canvas.freeDrawingBrush.width = parseInt(e.target.value, 10); 
  });
  if(brushColorInput) brushColorInput.addEventListener('input', (e) => { 
      if(canvas.isDrawingMode) canvas.freeDrawingBrush.color = e.target.value; 
  });

  // --- 3. POLYGON EDITING LOGIC ---
  function polygonPositionHandler(dim, finalMatrix, fabricObject) {
    var x = fabricObject.points[this.pointIndex].x - fabricObject.pathOffset.x,
      y = fabricObject.points[this.pointIndex].y - fabricObject.pathOffset.y;
    return fabric.util.transformPoint(
      { x: x, y: y },
      fabric.util.multiplyTransformMatrices(
        fabricObject.canvas.viewportTransform,
        fabricObject.calcTransformMatrix()
      )
    );
  }

  function actionHandler(eventData, transform, x, y) {
    var polygon = transform.target,
      currentControl = polygon.controls[polygon.__corner],
      mouseLocalPosition = polygon.toLocalPoint(new fabric.Point(x, y), "center", "center"),
      polygonBaseSize = polygon._getNonTransformedDimensions(),
      size = polygon._getTransformedDimensions(0, 0),
      finalPointPosition = {
        x: (mouseLocalPosition.x * polygonBaseSize.x) / size.x + polygon.pathOffset.x,
        y: (mouseLocalPosition.y * polygonBaseSize.y) / size.y + polygon.pathOffset.y,
      };
    polygon.points[currentControl.pointIndex] = finalPointPosition;
    return true;
  }

  function anchorWrapper(anchorIndex, fn) {
    return function (eventData, transform, x, y) {
      var fabricObject = transform.target,
        absolutePoint = fabric.util.transformPoint(
          {
            x: fabricObject.points[anchorIndex].x - fabricObject.pathOffset.x,
            y: fabricObject.points[anchorIndex].y - fabricObject.pathOffset.y,
          },
          fabricObject.calcTransformMatrix()
        ),
        actionPerformed = fn(eventData, transform, x, y),
        newDim = fabricObject._setPositionDimensions({}),
        polygonBaseSize = fabricObject._getNonTransformedDimensions(),
        newX = (fabricObject.points[anchorIndex].x - fabricObject.pathOffset.x) / polygonBaseSize.x,
        newY = (fabricObject.points[anchorIndex].y - fabricObject.pathOffset.y) / polygonBaseSize.y;
      fabricObject.setPositionByOrigin(absolutePoint, newX + 0.5, newY + 0.5);
      return actionPerformed;
    };
  }

  function editPolygon(poly) {
    canvas.setActiveObject(poly);
    poly.edit = !poly.edit;
    if (poly.edit) {
      var lastControl = poly.points.length - 1;
      poly.cornerStyle = "circle";
      poly.cornerColor = "rgba(0,0,255,0.5)";
      poly.controls = poly.points.reduce(function (acc, point, index) {
        acc["p" + index] = new fabric.Control({
          positionHandler: polygonPositionHandler,
          actionHandler: anchorWrapper(index > 0 ? index - 1 : lastControl, actionHandler),
          actionName: "modifyPolygon",
          pointIndex: index,
        });
        return acc;
      }, {});
    } else {
      poly.cornerColor = "white";
      poly.cornerStyle = "rect";
      poly.controls = fabric.Object.prototype.controls;
    }
    poly.hasBorders = !poly.edit;
    canvas.requestRenderAll();
  }

  // --- 4. IMAGE UPLOAD ---
  const imageUpload = document.getElementById("image-upload");
  if (imageUpload) {
    imageUpload.addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const formData = new FormData();
      formData.append("image", file);

      fetch("/upload/", { method: "POST", body: formData })
        .then((res) => res.json())
        .then((data) => {
          if (data.error) { alert(data.error); return; }
          activeImageId = data.id;
          fabric.Image.fromURL(data.url, (img) => {
            if (!img) return;
            const scaleX = canvas.width / img.width;
            const scaleY = canvas.height / img.height;
            currentImageScale = { x: scaleX, y: scaleY };

            canvas.setBackgroundImage(img, canvas.renderAll.bind(canvas), {
              scaleX: scaleX, scaleY: scaleY, originX: "left", originY: "top",
            });
            history = []; historyIndex = -1; saveState();
          });
        });
    });
  }

  // --- 5. AI AUTO-DETECT (YOLO-WORLD + SAM) ---
  const btnAutoDetect = document.getElementById('btn-auto-detect');
  const aiInput = document.getElementById('ai-prompt');

  if(btnAutoDetect) {
      btnAutoDetect.addEventListener('click', () => {
          if(!activeImageId) { alert("⚠️ Upload image first"); return; }
          
          const promptText = aiInput ? aiInput.value : 'car, bike, person, tree, cloud';
          
          document.body.style.cursor = 'wait';
          btnAutoDetect.disabled = true;
          btnAutoDetect.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Processing...';

          fetch(`/auto-detect/${activeImageId}/?prompt=${encodeURIComponent(promptText)}`)
          .then(res => res.json())
          .then(data => {
              document.body.style.cursor = 'default';
              btnAutoDetect.disabled = false;
              btnAutoDetect.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> Detect All';
              
              if(data.error) { alert(data.error); return; }
              if (data.annotations.length === 0) { alert("AI found nothing matching: " + promptText); return; }

              data.annotations.forEach(shape => {
                  let fabricShape;
                  if (shape.type === 'polygon') {
                      const scaledPoints = shape.points.map(p => ({
                          x: p.x * currentImageScale.x,
                          y: p.y * currentImageScale.y
                      }));
                      fabricShape = new fabric.Polygon(scaledPoints, {
                          fill: shape.fill, stroke: shape.stroke, strokeWidth: 1, strokeUniform: true,
                          objectCaching: false, label: shape.label, class: 'auto',
                          transparentCorners: false, cornerColor: 'white'
                      });
                  } else {
                      const scaledLeft = shape.left * currentImageScale.x;
                      const scaledTop = shape.top * currentImageScale.y;
                      const scaledWidth = shape.width * currentImageScale.x;
                      const scaledHeight = shape.height * currentImageScale.y;
                      fabricShape = new fabric.Rect({
                          left: scaledLeft, top: scaledTop, width: scaledWidth, height: scaledHeight,
                          fill: shape.fill, stroke: shape.stroke, strokeWidth: 2, objectCaching: false,
                          label: shape.label, class: 'auto', transparentCorners: false
                      });
                  }
                  if (fabricShape) canvas.add(fabricShape);
              });
              canvas.renderAll(); updateLayersList(); saveState();
          })
          .catch(err => {
              console.error(err);
              document.body.style.cursor = 'default';
              btnAutoDetect.disabled = false;
              alert("AI Error. Check console.");
          });
      });
  }

  // --- 6. CANVAS EVENTS (Drawing & Editing) ---
  canvas.on("mouse:dblclick", (opt) => {
    if (opt.target && opt.target.type === "polygon") {
      editPolygon(opt.target);
    }
  });

  canvas.on("mouse:down", (opt) => {
    const pointer = canvas.getPointer(opt.e);
    const activeColor = document.getElementById("brush-color")?.value || "#f00";

    if (currentTool === "pan" || opt.e.altKey || opt.e.button === 1) {
      isPanning = true;
      lastPanPoint = { x: opt.e.clientX, y: opt.e.clientY };
      canvas.defaultCursor = "grabbing";
      return;
    }

    if (canvas.getActiveObject() && canvas.getActiveObject().edit) return;

    if (currentTool === "polygon") {
      if (polygon.active) {
        if (opt.e.button === 2) finalizePolygon();
        else addPolygonPoint(pointer);
      } else {
        startPolygon(pointer);
      }
      return;
    }
    if (currentTool === "rectangle" || currentTool === "circle") {
      isDrawingShape = true;
      origX = pointer.x;
      origY = pointer.y;
      let shape;
      if (currentTool === "rectangle")
        shape = new fabric.Rect({
          left: origX, top: origY, width: 0, height: 0,
          fill: activeColor + "80", stroke: activeColor, strokeWidth: 2, transparentCorners: false,
        });
      else
        shape = new fabric.Circle({
          left: origX, top: origY, radius: 0,
          fill: activeColor + "80", stroke: activeColor, strokeWidth: 2, transparentCorners: false,
        });
      canvas.add(shape);
      canvas.setActiveObject(shape);
      currentObject = shape;
    }
  });

  canvas.on("mouse:move", (opt) => {
    const pointer = canvas.getPointer(opt.e);
    if (isPanning) {
      const dx = opt.e.clientX - lastPanPoint.x;
      const dy = opt.e.clientY - lastPanPoint.y;
      canvas.relativePan(new fabric.Point(dx, dy));
      lastPanPoint = { x: opt.e.clientX, y: opt.e.clientY };
      return;
    }
    if (isDrawingShape && currentObject) {
      if (currentTool === "rectangle") {
        if (origX > pointer.x) currentObject.set({ left: Math.abs(pointer.x) });
        if (origY > pointer.y) currentObject.set({ top: Math.abs(pointer.y) });
        currentObject.set({
          width: Math.abs(origX - pointer.x),
          height: Math.abs(origY - pointer.y),
        });
      } else if (currentTool === "circle") {
        const radius = Math.abs(origX - pointer.x) / 2;
        currentObject.set({ radius: radius });
        if (origX > pointer.x) currentObject.set({ left: pointer.x });
      }
      canvas.renderAll();
    }
    if (polygon.active && polygon.previewLine) {
      polygon.previewLine.set({ x2: pointer.x, y2: pointer.y }).setCoords();
      canvas.renderAll();
    }
  });

  canvas.on("mouse:up", () => {
    isPanning = false;
    if (isDrawingShape) {
      isDrawingShape = false;
      if (currentObject) {
        currentObject.setCoords();
        if (currentObject.width < 5 && currentObject.radius < 3)
          canvas.remove(currentObject);
        else {
          saveState();
          updateLayersList();
        }
      }
    }
  });

  // AUTO-FILL BRUSH DRAWINGS
  canvas.on('path:created', (e) => {
    if (currentTool === 'brush') {
        const pathObj = e.path;
        const activeColor = document.getElementById('brush-color').value || '#ff0000';
        pathObj.set({
            fill: activeColor + '80',
            stroke: activeColor,
            strokeWidth: 2,
            label: 'Brush Path',
            class: 'manual-draw'
        });
        canvas.renderAll();
        updateLayersList();
        saveState();
    }
  });

  // --- 7. Polygon Helpers ---
  function startPolygon(pointer) {
    polygon.active = true;
    polygon.points.push({ x: pointer.x, y: pointer.y });
    const circle = new fabric.Circle({ radius: 3, fill: "red", left: pointer.x, top: pointer.y, originX: "center", originY: "center", selectable: false, evented: false });
    polygon.lines.push(circle); canvas.add(circle);
    polygon.previewLine = new fabric.Line([pointer.x, pointer.y, pointer.x, pointer.y], { stroke: "red", strokeWidth: 1, selectable: false, evented: false });
    canvas.add(polygon.previewLine);
  }
  function addPolygonPoint(pointer) {
    const lastPoint = polygon.points[polygon.points.length - 1];
    polygon.points.push({ x: pointer.x, y: pointer.y });
    const line = new fabric.Line([lastPoint.x, lastPoint.y, pointer.x, pointer.y], { stroke: "red", strokeWidth: 2, selectable: false, evented: false });
    polygon.lines.push(line); canvas.add(line);
    polygon.previewLine.set({ x1: pointer.x, y1: pointer.y }).setCoords();
    canvas.renderAll();
  }
  function finalizePolygon() {
    if (!polygon.active || polygon.points.length < 3) { resetPolygonDrawing(); return; }
    const activeColor = document.getElementById("brush-color")?.value || "#f00";
    const finalPolygon = new fabric.Polygon(polygon.points, { fill: activeColor + "80", stroke: activeColor, strokeWidth: 2, objectCaching: false, label: "Polygon" });
    canvas.add(finalPolygon); resetPolygonDrawing(); updateLayersList(); saveState(); setActiveTool("select");
  }
  function resetPolygonDrawing() {
    polygon.active = false;
    polygon.lines.forEach((obj) => canvas.remove(obj));
    canvas.remove(polygon.previewLine);
    polygon.points = []; polygon.lines = []; polygon.previewLine = null;
    canvas.renderAll();
  }

  // --- 8. Save Logic (Un-Scaling) ---
  document.getElementById("save-annotations")?.addEventListener("click", () => {
    if (!activeImageId) { alert("No image"); return; }
    const objects = canvas.getObjects().filter((obj) => obj.type !== "image" && obj.evented !== false);

    const annotations = objects.map((obj) => {
      let points = null;
      if (obj.type === "polygon" && obj.points) {
        points = obj.points.map((p) => ({
          x: p.x / currentImageScale.x,
          y: p.y / currentImageScale.y,
        }));
      }
      // Handle brush paths
      let path = null;
      if(obj.type === 'path' && obj.path) {
          // Paths are harder to unscale point-by-point simply, usually we just save dimensions
          // or would need complex path parsing. 
          // For now, saving basic path data.
          path = obj.path; 
      }

      return {
        type: obj.type,
        left: obj.left / currentImageScale.x,
        top: obj.top / currentImageScale.y,
        width: (obj.width * obj.scaleX) / currentImageScale.x,
        height: (obj.height * obj.scaleY) / currentImageScale.y,
        fill: obj.fill, stroke: obj.stroke, points: points, path: path,
        label: obj.label || "untitled",
      };
    });

    fetch(`/save/${activeImageId}/`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ annotations: annotations }),
    }).then((res) => res.json()).then((data) => {
        if (data.success) alert("Saved!"); else alert("Error: " + data.error);
    });
  });

  // --- 9. Utils (History, Layers, Resize) ---
  function saveState() {
    if (polygon.active) return;
    const json = canvas.toJSON(["label", "class", "id"]);
    if (historyIndex < history.length - 1) history = history.slice(0, historyIndex + 1);
    history.push(json); historyIndex = history.length - 1;
  }
  function updateLayersList() {
    const list = document.getElementById("layers-list");
    if (!list) return;
    list.innerHTML = "";
    canvas.getObjects().filter((o) => o.type !== "image" && o.evented !== false).reverse().forEach((obj) => {
        const li = document.createElement("li");
        li.className = "layer-item";
        li.innerHTML = `<input type="color" class="layer-color" value="${obj.stroke}"><span class="layer-label" contenteditable="true">${obj.label || obj.type}</span><button class="btn-del"><i class="fa-solid fa-trash"></i></button>`;
        li.querySelector(".layer-color").addEventListener("input", (e) => { obj.set("stroke", e.target.value); obj.set("fill", e.target.value + "80"); canvas.renderAll(); });
        li.querySelector(".layer-label").addEventListener("blur", (e) => { obj.set("label", e.target.textContent); });
        li.querySelector(".btn-del").addEventListener("click", () => { canvas.remove(obj); updateLayersList(); saveState(); });
        list.appendChild(li);
      });
  }

  window.addEventListener("resize", () => {
    canvas.setWidth(window.innerWidth - 300);
    canvas.setHeight(window.innerHeight - 50);
  });

  // --- 10. KEYBOARD SHORTCUTS (With Fixes) ---
  window.addEventListener('keydown', (e) => {
    // 1. Don't trigger if user is typing in a box
    if (['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName) || document.activeElement.isContentEditable) {
        return;
    }

    // 2. Convert key to lowercase to fix Caps Lock issues
    const key = e.key.toLowerCase();

    // Now this function exists!
    if (key === 'v') setActiveTool('select');
    if (key === 'h') setActiveTool('pan');
    if (key === 'p') setActiveTool('polygon');
    if (key === 'b') setActiveTool('brush');
    if (key === 'r') setActiveTool('rectangle');
    if (key === 'c') setActiveTool('circle');
    if (key === 'e') setActiveTool('eraser');

    if ((e.ctrlKey || e.metaKey) && key === 'z') { e.preventDefault(); undo(); }
    if ((e.ctrlKey || e.metaKey) && key === 'y') { e.preventDefault(); redo(); }
    if (key === 'delete' || key === 'backspace') {
        canvas.getActiveObjects().forEach(obj => canvas.remove(obj));
        canvas.discardActiveObject().renderAll();
        updateLayersList();
        saveState();
    }
    if (key === 'enter' && polygon.active) finalizePolygon();
    if (key === 'escape') {
        if (polygon.active) resetPolygonDrawing();
        canvas.discardActiveObject().renderAll();
    }
  });

  // Undo/Redo Functions
  function undo() { if (historyIndex > 0) { historyIndex--; canvas.loadFromJSON(history[historyIndex], () => { canvas.renderAll(); updateLayersList(); }); } }
  function redo() { if (historyIndex < history.length - 1) { historyIndex++; canvas.loadFromJSON(history[historyIndex], () => { canvas.renderAll(); updateLayersList(); }); } }

  document.getElementById('undo')?.addEventListener('click', undo);
  document.getElementById('redo')?.addEventListener('click', redo);

  // Initial Setup
  setActiveTool('select');
  saveState();
});