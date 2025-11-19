from django.shortcuts import render, get_object_or_404
from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt
from django.conf import settings
from .models import AnnotatedImage
import json
import os
import zipfile
import io
from django.http import HttpResponse
import math
from ultralytics import YOLO
import numpy as np
import random
model = YOLO('yolov8l-seg.pt')  

def index(request):
    images = AnnotatedImage.objects.all().order_by('-uploaded_at')
    return render(request, 'annotator/index.html', {'images': images})

@csrf_exempt
def upload_image(request):
    print("--------------------------------------------------")
    print("DEBUG: Upload request received.")
    print(f"DEBUG: MEDIA_ROOT setting is: {settings.MEDIA_ROOT}")
    
    if request.method == 'POST':
        # Check if file is in request
        if 'image' not in request.FILES:
            print("ERROR: No 'image' key found in request.FILES")
            return JsonResponse({'error': 'No image provided'}, status=400)

        image_file = request.FILES['image']
        print(f"DEBUG: File received: {image_file.name} (Size: {image_file.size} bytes)")

        try:
            # create the database record
            annotated_image = AnnotatedImage.objects.create(image=image_file)
            
            # Check where it saved
            full_path = annotated_image.image.path
            print(f"DEBUG: Database thinks file is at: {full_path}")
            
            # Check if file actually exists on disk
            if os.path.exists(full_path):
                print("SUCCESS: File verified on disk!")
            else:
                print("CRITICAL FAILURE: File was saved to DB but NOT found on disk.")
                # Try to list the directory to see what IS there
                dir_path = os.path.dirname(full_path)
                if os.path.exists(dir_path):
                    print(f"DEBUG: Content of {dir_path}: {os.listdir(dir_path)}")
                else:
                    print(f"DEBUG: The directory {dir_path} does not even exist!")

            return JsonResponse({'id': annotated_image.id, 'url': annotated_image.image.url})
            
        except Exception as e:
            print(f"EXCEPTION OCCURRED: {str(e)}")
            return JsonResponse({'error': str(e)}, status=500)

    return JsonResponse({'error': 'Invalid request'}, status=400)

@csrf_exempt
def save_annotations(request, image_id):
    if request.method == 'POST':
        try:
            image = get_object_or_404(AnnotatedImage, id=image_id)
            data = json.loads(request.body)
            image.set_annotations(data.get('annotations'))
            image.save()
            return JsonResponse({'success': True})
        except Exception as e:
            return JsonResponse({'error': str(e)}, status=500)
    return JsonResponse({'error': 'Invalid request method'}, status=400)



# --- HELPER: Convert any shape to a list of points ---
def get_polygon_points(ann):
    """
    Converts Fabric.js objects (rect, circle, polygon) into a list of [x, y] points.
    """
    shape_type = ann.get('type')
    points = []
    
    left = ann.get('left', 0)
    top = ann.get('top', 0)
    # Fabric stores dimensions scaled
    width = ann.get('width', 0) 
    height = ann.get('height', 0)

    if shape_type == 'polygon':
        # Fabric stores polygon points relative to the object center/left.
        # We need to map them to absolute image coordinates if they aren't already.
        # Note: In our JS implementation, we stored absolute points in 'points'.
        raw_points = ann.get('points', [])
        for p in raw_points:
            points.append([p['x'], p['y']])

    elif shape_type == 'rect' or shape_type == 'rectangle':
        # Convert Rect to 4 points (TL, TR, BR, BL)
        points = [
            [left, top],
            [left + width, top],
            [left + width, top + height],
            [left, top + height]
        ]

    elif shape_type == 'circle':
        # Approximate circle with 16 points
        radius = ann.get('radius', width/2)
        center_x = left + radius
        center_y = top + radius
        for i in range(16):
            angle = (math.pi * 2 * i) / 16
            px = center_x + (math.cos(angle) * radius)
            py = center_y + (math.sin(angle) * radius)
            points.append([px, py])

    return points

# --- EXPORT: YOLO FORMAT (Segmentation) ---
def export_yolo(request):
    # 1. Collect all unique classes to assign IDs (0, 1, 2...)
    all_images = AnnotatedImage.objects.exclude(annotations__isnull=True).exclude(annotations__exact='')
    
    class_map = {}
    class_id_counter = 0
    
    # Create a ZIP file in memory
    zip_buffer = io.BytesIO()
    
    with zipfile.ZipFile(zip_buffer, 'w') as zf:
        
        # Iterate over every image
        for img_obj in all_images:
            try:
                data = json.loads(img_obj.annotations)
                if not data: continue
                
                # Open image file to get real dimensions
                # (We need this to normalize coordinates to 0-1)
                with img_obj.image.open() as pil_img:
                    img_w, img_h = pil_img.width, pil_img.height

                yolo_lines = []
                
                for ann in data:
                    label = ann.get('label', 'default').lower().strip()
                    
                    # Assign ID if new label
                    if label not in class_map:
                        class_map[label] = class_id_counter
                        class_id_counter += 1
                    
                    cls_id = class_map[label]
                    points = get_polygon_points(ann)
                    
                    # Normalize points (x/W, y/H)
                    normalized_points = []
                    for pt in points:
                        nx = max(0, min(1, pt[0] / img_w)) # Clamp between 0-1
                        ny = max(0, min(1, pt[1] / img_h))
                        normalized_points.extend([f"{nx:.6f}", f"{ny:.6f}"])
                    
                    if normalized_points:
                        # YOLO Format: <class-id> <x1> <y1> <x2> <y2> ...
                        line = f"{cls_id} " + " ".join(normalized_points)
                        yolo_lines.append(line)
                
                # Write .txt file for this image
                txt_filename = os.path.splitext(os.path.basename(img_obj.image.name))[0] + ".txt"
                zf.writestr(txt_filename, "\n".join(yolo_lines))
                
            except Exception as e:
                print(f"Skipping image {img_obj.id}: {e}")

        # Write classes.txt
        classes_content = "\n".join([k for k, v in sorted(class_map.items(), key=lambda item: item[1])])
        zf.writestr("classes.txt", classes_content)

    # Return ZIP download
    zip_buffer.seek(0)
    response = HttpResponse(zip_buffer, content_type='application/zip')
    response['Content-Disposition'] = 'attachment; filename="yolo_dataset.zip"'
    return response

# --- EXPORT: COCO FORMAT (Mask R-CNN) ---
def export_coco(request):
    images = []
    annotations = []
    categories = []
    
    class_map = {}
    class_id_counter = 1 # COCO starts at 1 usually
    ann_id_counter = 1
    
    all_db_images = AnnotatedImage.objects.exclude(annotations__isnull=True)

    for img_obj in all_db_images:
        try:
            data = json.loads(img_obj.annotations)
            if not data: continue
            
            with img_obj.image.open() as pil_img:
                width, height = pil_img.width, pil_img.height
                
            image_info = {
                "id": img_obj.id,
                "file_name": os.path.basename(img_obj.image.name),
                "width": width,
                "height": height
            }
            images.append(image_info)
            
            for ann in data:
                label = ann.get('label', 'default').lower().strip()
                
                if label not in class_map:
                    class_map[label] = class_id_counter
                    categories.append({"id": class_id_counter, "name": label, "supercategory": "none"})
                    class_id_counter += 1
                
                points = get_polygon_points(ann)
                # COCO segmentation is [x1, y1, x2, y2, ...] flat list
                segmentation = []
                x_coords = []
                y_coords = []
                
                for pt in points:
                    segmentation.extend([pt[0], pt[1]])
                    x_coords.append(pt[0])
                    y_coords.append(pt[1])
                
                if not x_coords: continue

                # Bounding Box [x, y, width, height]
                min_x = min(x_coords)
                min_y = min(y_coords)
                box_w = max(x_coords) - min_x
                box_h = max(y_coords) - min_y
                
                coco_ann = {
                    "id": ann_id_counter,
                    "image_id": img_obj.id,
                    "category_id": class_map[label],
                    "segmentation": [segmentation],
                    "area": box_w * box_h, # Simplified area
                    "bbox": [min_x, min_y, box_w, box_h],
                    "iscrowd": 0
                }
                annotations.append(coco_ann)
                ann_id_counter += 1

        except Exception as e:
            print(f"Error processing image {img_obj.id}: {e}")

    coco_output = {
        "images": images,
        "annotations": annotations,
        "categories": categories
    }

    # Return JSON download
    response = HttpResponse(json.dumps(coco_output, indent=4), content_type='application/json')
    response['Content-Disposition'] = 'attachment; filename="coco_annotations.json"'
    return response


def auto_detect(request, image_id):
    try:
        img_obj = AnnotatedImage.objects.get(id=image_id)
        image_path = img_obj.image.path
        
        print(f"DEBUG: Running High-Quality AI on {image_path}")

        # --- THE FIX IS HERE ---
        # retina_masks=True:  Generates high-res, smooth polygon boundaries
        # conf=0.4:           Only keeps objects the AI is 40% sure about (removes noise)
        # iou=0.5:            Prevents overlapping duplicate boxes
        # imgsz=1280:         Processes at higher resolution (standard is 640)
        
        results = model(image_path, conf=0.4, iou=0.5, retina_masks=True, imgsz=1280) 
        result = results[0]

        new_annotations = []
        
        if result.masks:
            names = result.names 
            
            # result.masks.xy returns coordinates mapped to the ORIGINAL image size
            for i, mask in enumerate(result.masks.xy):
                
                # Skip empty or tiny masks that look like glitches
                if len(mask) < 3: 
                    continue

                # Convert numpy points to [{'x':.., 'y':..}]
                points = [{'x': float(pt[0]), 'y': float(pt[1])} for pt in mask]
                
                cls_id = int(result.boxes.cls[i].item())
                label_name = names[cls_id]
                
                color = "#%06x" % random.randint(0, 0xFFFFFF)

                annotation = {
                    "type": "polygon",
                    "points": points,
                    "label": label_name,
                    "class": "auto-detected",
                    "stroke": color,
                    "fill": color + "40", 
                    "left": 0, 
                    "top": 0,
                    "width": 0,
                    "height": 0
                }
                new_annotations.append(annotation)

        print(f"DEBUG: AI found {len(new_annotations)} high-quality objects.")
        return JsonResponse({'success': True, 'annotations': new_annotations})

    except Exception as e:
        print(f"AI Error: {e}")
        return JsonResponse({'error': str(e)}, status=500)