document.addEventListener("DOMContentLoaded", () => {
  console.log("✅ Annotation Tool JavaScript is RUNNING!");

  // --- 1. Canvas & State Initialization ---
  const canvas = new fabric.Canvas("canvas", {
    width: window.innerWidth - 300,
    height: window.innerHeight - 50,
    backgroundColor: "#222", // Darker background for better contrast
    selection: true,
    fireRightClick: true,
    stopContextMenu: true,
  });

  // State Variables
  let currentTool = "select";
  let isDrawingShape = false;
  let activeImageId = null;
  let currentObject = null;

  // *** NEW: Track Image Scaling ***
  // This ensures AI shapes align perfectly even if image is stretched
  let currentImageScale = { x: 1, y: 1 };

  // Helpers
  let origX, origY;
  let polygon = { active: false, points: [], lines: [], previewLine: null };
  let isPanning = false;
  let lastPanPoint = { x: 0, y: 0 };
  let history = [];
  let historyIndex = -1;

  // --- 2. IMAGE UPLOAD LOGIC (With Scaling Fix) ---
  const imageUpload = document.getElementById("image-upload");
  if (imageUpload) {
    imageUpload.addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (!file) return;

      const formData = new FormData();
      formData.append("image", file);

      fetch("/upload/", { method: "POST", body: formData })
        .then((response) => response.json())
        .then((data) => {
          if (data.error) {
            alert("Server Error: " + data.error);
            return;
          }

          console.log("✅ Image uploaded. ID:", data.id);
          activeImageId = data.id;

          fabric.Image.fromURL(data.url, (img) => {
            if (!img) return;

            // Calculate Scale to fit screen
            const scaleX = canvas.width / img.width;
            const scaleY = canvas.height / img.height;

            // Store this for the AI to use later!
            currentImageScale = { x: scaleX, y: scaleY };

            canvas.setBackgroundImage(img, canvas.renderAll.bind(canvas), {
              scaleX: scaleX,
              scaleY: scaleY,
              originX: "left",
              originY: "top",
            });

            // Reset history
            history = [];
            historyIndex = -1;
            saveState();
          });
        })
        .catch((err) => console.error("❌ Upload Error:", err));
    });
  }

  // --- 3. AI AUTO-DETECT LOGIC (With Coordinate Scaling) ---
  const btnAutoDetect = document.getElementById("btn-auto-detect");

  if (btnAutoDetect) {
    btnAutoDetect.addEventListener("click", () => {
      if (!activeImageId) {
        alert("⚠️ Please upload an image first!");
        return;
      }

      // UI Feedback
      document.body.style.cursor = "wait";
      btnAutoDetect.disabled = true;
      const originalBtnText = btnAutoDetect.innerHTML;
      btnAutoDetect.innerHTML =
        '<i class="fa-solid fa-spinner fa-spin"></i> Analyzing...';

      console.log("🤖 AI is analyzing...");

      fetch(`/auto-detect/${activeImageId}/`)
        .then((response) => response.json())
        .then((data) => {
          document.body.style.cursor = "default";
          btnAutoDetect.disabled = false;
          btnAutoDetect.innerHTML = originalBtnText;

          if (data.error) {
            alert("AI Error: " + data.error);
            return;
          }

          const newShapes = data.annotations;
          if (newShapes.length === 0) {
            alert("AI couldn't find objects.");
            return;
          }

          // DRAW SHAPES (Applying Scale)
          newShapes.forEach((shape) => {
            // *** CRITICAL FIX: Scale Points to match Canvas Image ***
            const scaledPoints = shape.points.map((p) => ({
              x: p.x * currentImageScale.x,
              y: p.y * currentImageScale.y,
            }));

            const fabricShape = new fabric.Polygon(scaledPoints, {
              fill: shape.fill,
              stroke: shape.stroke,
              strokeWidth: 1, // Thin line for precision
              strokeUniform: true, // Keep line thin on zoom
              objectCaching: false, // Sharp edges
              label: shape.label,
              class: "auto",
              perPixelTargetFind: true,
              cornerColor: "white",
              cornerSize: 8,
              transparentCorners: false,
            });
            canvas.add(fabricShape);
          });

          canvas.renderAll();
          updateLayersList();
          saveState();
          console.log(`✅ Added ${newShapes.length} aligned annotations.`);
        })
        .catch((err) => {
          document.body.style.cursor = "default";
          btnAutoDetect.disabled = false;
          btnAutoDetect.innerHTML = originalBtnText;
          console.error("AI Request Failed:", err);
        });
    });
  }

  // --- 4. SAVE BUTTON LOGIC ---
  const saveBtn = document.getElementById("save-annotations");
  if (saveBtn) {
    saveBtn.addEventListener("click", () => {
      if (!activeImageId) {
        alert("⚠️ No image selected!");
        return;
      }

      // Filter valid objects
      const objects = canvas
        .getObjects()
        .filter((obj) => obj.type !== "image" && obj.evented !== false);

      const annotations = objects.map((obj) => {
        // We need to UN-SCALE the data before saving to DB
        // So it matches the original image resolution again
        let points = null;
        if (obj.type === "polygon" && obj.points) {
          points = obj.points.map((p) => ({
            x: p.x / currentImageScale.x,
            y: p.y / currentImageScale.y,
          }));
        }

        return {
          type: obj.type,
          // Coordinates relative to canvas need to be unscaled too if using left/top
          left: obj.left / currentImageScale.x,
          top: obj.top / currentImageScale.y,
          width: (obj.width * obj.scaleX) / currentImageScale.x,
          height: (obj.height * obj.scaleY) / currentImageScale.y,
          fill: obj.fill,
          stroke: obj.stroke,
          points: points, // Save unscaled points
          label: obj.label || "untitled",
          class: obj.class || "default",
        };
      });

      fetch(`/save/${activeImageId}/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ annotations: annotations }),
      })
        .then((res) => res.json())
        .then((data) => {
          if (data.success) alert("✅ Annotations Saved Successfully!");
          else alert("❌ Save Failed: " + data.error);
        });
    });
  }

  // --- 5. Tool Selection (Boilerplate) ---
  const brushOptions = document.getElementById("brush-options");
  const brushSizeInput = document.getElementById("brush-size");
  const brushColorInput = document.getElementById("brush-color");

  function setActiveTool(toolName) {
    currentTool = toolName;
    document
      .querySelectorAll(".tool-btn")
      .forEach((btn) =>
        btn.classList.toggle("active", btn.dataset.tool === toolName)
      );
    canvas.isDrawingMode = false;
    canvas.selection = toolName === "select";
    canvas.defaultCursor = toolName === "select" ? "default" : "crosshair";
    canvas.forEachObject((obj) =>
      obj.set({ selectable: toolName === "select" })
    );
    canvas.discardActiveObject().renderAll();
    if (brushOptions)
      brushOptions.classList.toggle(
        "hidden",
        !["brush", "eraser"].includes(toolName)
      );
    if (toolName !== "polygon" && polygon.active) resetPolygonDrawing();
    if (toolName === "brush") {
      canvas.isDrawingMode = true;
      canvas.freeDrawingBrush = new fabric.PencilBrush(canvas);
      canvas.freeDrawingBrush.width = parseInt(brushSizeInput.value, 10) || 10;
      canvas.freeDrawingBrush.color = brushColorInput.value || "#ff0000";
    } else if (toolName === "eraser") {
      canvas.isDrawingMode = true;
      canvas.freeDrawingBrush = new fabric.PencilBrush(canvas);
      canvas.freeDrawingBrush.width = 30;
      canvas.freeDrawingBrush.color = "#333333";
    }
  }

  document
    .querySelectorAll(".tool-btn")
    .forEach((btn) =>
      btn.addEventListener("click", () => setActiveTool(btn.dataset.tool))
    );
  if (brushSizeInput)
    brushSizeInput.addEventListener("input", (e) => {
      if (canvas.isDrawingMode)
        canvas.freeDrawingBrush.width = parseInt(e.target.value, 10);
    });
  if (brushColorInput)
    brushColorInput.addEventListener("input", (e) => {
      if (canvas.isDrawingMode) canvas.freeDrawingBrush.color = e.target.value;
    });

  // --- 6. Canvas Drawing Events (Polygon/Rect/Circle/Pan) ---
  canvas.on("mouse:down", (opt) => {
    const pointer = canvas.getPointer(opt.e);
    const activeColor = brushColorInput ? brushColorInput.value : "#ff0000";

    if (currentTool === "pan" || opt.e.altKey || opt.e.button === 1) {
      isPanning = true;
      lastPanPoint = { x: opt.e.clientX, y: opt.e.clientY };
      canvas.defaultCursor = "grabbing";
      return;
    }
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
      if (currentTool === "rectangle") {
        shape = new fabric.Rect({
          left: origX,
          top: origY,
          width: 0,
          height: 0,
          fill: activeColor + "80",
          stroke: activeColor,
          strokeWidth: 2,
          transparentCorners: false,
          label: "Rect",
        });
      } else {
        shape = new fabric.Circle({
          left: origX,
          top: origY,
          radius: 0,
          fill: activeColor + "80",
          stroke: activeColor,
          strokeWidth: 2,
          transparentCorners: false,
          label: "Circle",
        });
      }
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
        currentObject.set({ width: Math.abs(origX - pointer.x) });
        currentObject.set({ height: Math.abs(origY - pointer.y) });
      }
      if (currentTool === "circle") {
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
    canvas.defaultCursor = currentTool === "select" ? "default" : "crosshair";
  });

  // --- 7. Polygon Helpers ---
  function startPolygon(pointer) {
    polygon.active = true;
    polygon.points.push({ x: pointer.x, y: pointer.y });
    const circle = new fabric.Circle({
      radius: 3,
      fill: "red",
      left: pointer.x,
      top: pointer.y,
      originX: "center",
      originY: "center",
      selectable: false,
      evented: false,
    });
    polygon.lines.push(circle);
    canvas.add(circle);
    polygon.previewLine = new fabric.Line(
      [pointer.x, pointer.y, pointer.x, pointer.y],
      { stroke: "red", strokeWidth: 1, selectable: false, evented: false }
    );
    canvas.add(polygon.previewLine);
  }
  function addPolygonPoint(pointer) {
    const lastPoint = polygon.points[polygon.points.length - 1];
    polygon.points.push({ x: pointer.x, y: pointer.y });
    const line = new fabric.Line(
      [lastPoint.x, lastPoint.y, pointer.x, pointer.y],
      { stroke: "red", strokeWidth: 2, selectable: false, evented: false }
    );
    polygon.lines.push(line);
    canvas.add(line);
    polygon.previewLine.set({ x1: pointer.x, y1: pointer.y }).setCoords();
    canvas.renderAll();
  }
  function finalizePolygon() {
    if (!polygon.active || polygon.points.length < 3) {
      resetPolygonDrawing();
      return;
    }
    const finalPolygon = new fabric.Polygon(polygon.points, {
      fill: (brushColorInput.value || "#f00") + "80",
      stroke: brushColorInput.value || "#f00",
      strokeWidth: 2,
      objectCaching: false,
      label: "Polygon",
    });
    canvas.add(finalPolygon);
    resetPolygonDrawing();
    updateLayersList();
    saveState();
    setActiveTool("select");
  }
  function resetPolygonDrawing() {
    polygon.active = false;
    polygon.lines.forEach((obj) => canvas.remove(obj));
    canvas.remove(polygon.previewLine);
    polygon.points = [];
    polygon.lines = [];
    polygon.previewLine = null;
    canvas.renderAll();
  }

  // --- 8. History & Layers ---
  function saveState() {
    if (polygon.active) return;
    const json = canvas.toJSON(["label", "class", "id"]);
    if (historyIndex < history.length - 1)
      history = history.slice(0, historyIndex + 1);
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
  function updateLayersList() {
    const layersList = document.getElementById("layers-list");
    if (!layersList) return;
    layersList.innerHTML = "";
    const objects = canvas
      .getObjects()
      .filter((obj) => obj.evented !== false && obj.type !== "image")
      .slice()
      .reverse();
    objects.forEach((obj, index) => {
      const li = document.createElement("li");
      li.className = "layer-item";
      li.innerHTML = `<input type="color" class="layer-color" value="${
        obj.stroke || "#ff0000"
      }"><span class="layer-label" contenteditable="true">${
        obj.label || obj.type
      }</span><button class="btn-delete"><i class="fa-solid fa-trash-can"></i></button>`;
      li.querySelector(".layer-color").addEventListener("input", (e) => {
        obj.set("stroke", e.target.value);
        obj.set("fill", e.target.value + "80");
        canvas.renderAll();
      });
      li.querySelector(".layer-label").addEventListener("blur", (e) => {
        obj.set("label", e.target.textContent);
      });
      li.querySelector(".btn-delete").addEventListener("click", () => {
        canvas.remove(obj);
        updateLayersList();
        saveState();
      });
      layersList.appendChild(li);
    });
  }

  // --- 9. Init ---
  window.addEventListener("resize", () => {
    canvas.setWidth(window.innerWidth - 300);
    canvas.setHeight(window.innerHeight - 50);
  });
  window.addEventListener("keydown", (e) => {
    if (["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)) return;
    if (e.key === "v") setActiveTool("select");
    if (e.key === "p") setActiveTool("polygon");
    if (e.key === "r") setActiveTool("rectangle");
    if (e.key === "c") setActiveTool("circle");
    if (e.ctrlKey && e.key === "z") undo();
    if (e.key === "Delete") {
      canvas.getActiveObjects().forEach((o) => canvas.remove(o));
      canvas.discardActiveObject().renderAll();
      updateLayersList();
      saveState();
    }
    if (e.key === "Enter" && polygon.active) finalizePolygon();
  });
  setActiveTool("select");
  saveState();
});
