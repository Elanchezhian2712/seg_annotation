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
import numpy as np
import random
from ultralytics import SAM, YOLO
import torch
import os
import re
import base64
from django.core.files.base import ContentFile
import yaml 
from pycocotools import mask as mask_utils 
from PIL import Image 
import numpy as np


# model = YOLO('yolov8l-seg.pt')  
detector = YOLO('yolov8l-worldv2.pt')
segmenter = SAM('mobile_sam.pt') 

def index(request):
    images = AnnotatedImage.objects.all().order_by('-uploaded_at')
    return render(request, 'annotator/index.html', {'images': images})

@csrf_exempt
def upload_image(request):
    print("--------------------------------------------------")
    print("DEBUG: Upload request received.")
    print(f"DEBUG: MEDIA_ROOT setting is: {settings.MEDIA_ROOT}")
    
    if request.method == 'POST':
        if 'image' not in request.FILES:
            print("ERROR: No 'image' key found in request.FILES")
            return JsonResponse({'error': 'No image provided'}, status=400)

        image_file = request.FILES['image']
        print(f"DEBUG: File received: {image_file.name} (Size: {image_file.size} bytes)")

        try:
            annotated_image = AnnotatedImage.objects.create(image=image_file)
            
            full_path = annotated_image.image.path
            print(f"DEBUG: Database thinks file is at: {full_path}")
            
            if os.path.exists(full_path):
                print("SUCCESS: File verified on disk!")
            else:
                print("CRITICAL FAILURE: File was saved to DB but NOT found on disk.")
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




def get_polygon_points(ann):
    """
    Converts Fabric.js objects (rect, circle, polygon) into a list of [x, y] points.
    """
    shape_type = ann.get('type')
    points = []
    
    left = ann.get('left', 0)
    top = ann.get('top', 0)
    width = ann.get('width', 0) 
    height = ann.get('height', 0)

    if shape_type == 'polygon':
        raw_points = ann.get('points', [])
        for p in raw_points:
            points.append([p['x'], p['y']])

    elif shape_type == 'rect' or shape_type == 'rectangle':
        points = [
            [left, top],
            [left + width, top],
            [left + width, top + height],
            [left, top + height]
        ]

    elif shape_type == 'circle':
        radius = ann.get('radius', width/2)
        center_x = left + radius
        center_y = top + radius
        for i in range(16):
            angle = (math.pi * 2 * i) / 16
            px = center_x + (math.cos(angle) * radius)
            py = center_y + (math.sin(angle) * radius)
            points.append([px, py])

    return points



# --- HELPER: Calculate Tight Bounding Box ---
def get_bbox_from_points(points):
    """
    Calculates [x, y, width, height] from a list of dictionary points [{'x':1,'y':1},...].
    """
    if not points:
        return [0, 0, 0, 0]
    
    # Handle both dict format and list format
    xs = [p['x'] if isinstance(p, dict) else p[0] for p in points]
    ys = [p['y'] if isinstance(p, dict) else p[1] for p in points]
    
    x_min = min(xs)
    y_min = min(ys)
    x_max = max(xs)
    y_max = max(ys)
    
    return [x_min, y_min, x_max - x_min, y_max - y_min]

# --- HELPER: Convert PNG Mask to COCO RLE ---
def png_to_rle(mask_path):
    """
    Reads a binary PNG mask from disk and converts it to COCO RLE format.
    """
    try:
        # Convert absolute path if necessary, or assume relative to MEDIA_ROOT
        if not os.path.exists(mask_path):
             # Try finding it relative to project root if path is just /media/...
             if mask_path.startswith('/'):
                 mask_path = mask_path.lstrip('/')
        
        if not os.path.exists(mask_path):
            return None

        # Open image and convert to binary
        mask_img = np.array(Image.open(mask_path).convert("L"))
        binary_mask = (mask_img > 0).astype(np.uint8)
        
        # Encode
        rle = mask_utils.encode(np.asfortranarray(binary_mask))
        # Decode bytes to string for JSON serialization
        rle['counts'] = rle['counts'].decode('utf-8')
        return rle
    except Exception as e:
        print(f"RLE Conversion Error for {mask_path}: {e}")
        return None

# --- EXPORT: YOLO FORMAT (Production Ready) ---
def export_yolo(request):
    all_images = AnnotatedImage.objects.exclude(annotations__isnull=True)
    
    zip_buffer = io.BytesIO()
    class_map = {}
    class_id_counter = 0
    
    with zipfile.ZipFile(zip_buffer, 'w') as zf:
        
        for img_obj in all_images:
            try:
                db_data = json.loads(img_obj.annotations)
                if not db_data or 'annotations' not in db_data: continue

                # 1. Write Image File to Zip (images/filename.jpg)
                img_filename = os.path.basename(img_obj.image.name)
                zf.write(img_obj.image.path, arcname=f"images/{img_filename}")
                
                img_w = db_data.get('imagewidth')
                img_h = db_data.get('imageheight')
                
                yolo_lines = []
                
                for ann in db_data.get('annotations', []):
                    label = ann.get('label', 'unknown').lower().strip()
                    
                    # Manage Classes
                    if label not in class_map:
                        class_map[label] = class_id_counter
                        class_id_counter += 1
                    cls_id = class_map[label]
                    
                    # Get Points
                    points = ann.get('points', [])
                    if not points: continue

                    # Normalize Points (0.0 - 1.0)
                    normalized_points = []
                    for pt in points:
                        # Handle both {x,y} and [x,y] formats
                        px = pt['x'] if isinstance(pt, dict) else pt[0]
                        py = pt['y'] if isinstance(pt, dict) else pt[1]
                        
                        nx = max(0, min(1, px / img_w))
                        ny = max(0, min(1, py / img_h))
                        normalized_points.extend([f"{nx:.6f}", f"{ny:.6f}"])
                    
                    if normalized_points:
                        line = f"{cls_id} " + " ".join(normalized_points)
                        yolo_lines.append(line)
                
                # 2. Write Label File to Zip (labels/filename.txt)
                txt_filename = os.path.splitext(img_filename)[0] + ".txt"
                zf.writestr(f"labels/{txt_filename}", "\n".join(yolo_lines))
                
            except Exception as e:
                print(f"YOLO Export Error {img_obj.id}: {e}")

        # 3. Generate data.yaml
        # Create reverse map for YAML (id: name)
        names_map = {v: k for k, v in class_map.items()}
        yaml_data = {
            'path': '../datasets/custom', # Placeholder path
            'train': 'images',
            'val': 'images',
            'names': names_map
        }
        zf.writestr("data.yaml", yaml.dump(yaml_data, sort_keys=False))

    zip_buffer.seek(0)
    response = HttpResponse(zip_buffer, content_type='application/zip')
    response['Content-Disposition'] = 'attachment; filename="yolo_dataset_v8_seg.zip"'
    return response

# --- EXPORT: COCO FORMAT (With RLE & Correct BBox) ---
def export_coco(request):
    images = []
    annotations = []
    categories = []
    
    class_map = {}
    class_id_counter = 1
    ann_id_counter = 1
    
    all_db_images = AnnotatedImage.objects.exclude(annotations__isnull=True)

    for img_obj in all_db_images:
        try:
            db_data = json.loads(img_obj.annotations)
            
            # 1. Image Info
            image_info = {
                "id": img_obj.id,
                "file_name": os.path.basename(img_obj.image.name),
                "width": db_data.get('imagewidth'),
                "height": db_data.get('imageheight'),
                "date_captured": str(img_obj.uploaded_at), # Optional but nice
                "license": 1,
            }
            images.append(image_info)
            
            # 2. Process Annotations
            for ann in db_data.get('annotations', []):
                label = ann.get('label', 'unknown').lower().strip()
                
                if label not in class_map:
                    class_map[label] = class_id_counter
                    categories.append({"id": class_id_counter, "name": label, "supercategory": "none"})
                    class_id_counter += 1
                
                # A. Get Points & Calculate Tight BBox
                points_data = ann.get('points', [])
                if not points_data: continue
                
                # Calculate bbox from points (More accurate than frontend coords)
                x, y, w, h = get_bbox_from_points(points_data)
                
                # B. Prepare Segmentation (Polygon)
                # COCO Polygon format: [[x1, y1, x2, y2, ...]]
                poly_seg = []
                for pt in points_data:
                    px = pt['x'] if isinstance(pt, dict) else pt[0]
                    py = pt['y'] if isinstance(pt, dict) else pt[1]
                    poly_seg.extend([px, py])
                
                # C. Prepare Segmentation (RLE) - OPTIONAL BUT POWERFUL
                # This is what Mask R-CNN often prefers for pixel-perfect training
                segmentation_output = [poly_seg] # Default to polygon
                
                mask_url = ann.get('masked_image')
                if mask_url:
                    # Convert URL to filesystem path
                    # Assumes MEDIA_ROOT is set correctly in settings
                    # E.g., /media/individual_masks/... -> /var/www/media/individual_masks/...
                    relative_path = mask_url.replace(settings.MEDIA_URL, '')
                    full_mask_path = os.path.join(settings.MEDIA_ROOT, relative_path)
                    
                    rle_data = png_to_rle(full_mask_path)
                    if rle_data:
                        segmentation_output = rle_data # Override polygon with RLE if successful

                coco_ann = {
                    "id": ann_id_counter,
                    "image_id": img_obj.id,
                    "category_id": class_map[label],
                    "segmentation": segmentation_output,
                    "area": w * h, # Area is roughly w*h, or calculate polygon area if needed
                    "bbox": [x, y, w, h],
                    "iscrowd": 0
                }
                annotations.append(coco_ann)
                ann_id_counter += 1

        except Exception as e:
            print(f"COCO Export Error {img_obj.id}: {e}")

    coco_output = {
        "info": {
            "description": "Custom AI Dataset",
            "year": 2025,
            "version": "1.0",
            "contributor": "Annotation Tool"
        },
        "licenses": [{"id": 1, "name": "Proprietary"}],
        "images": images,
        "annotations": annotations,
        "categories": categories
    }

    response = HttpResponse(json.dumps(coco_output, indent=4), content_type='application/json')
    response['Content-Disposition'] = 'attachment; filename="coco_dataset_v2.json"'
    return response


def auto_detect(request, image_id):
    try:
        img_obj = AnnotatedImage.objects.get(id=image_id)
        image_path = img_obj.image.path
        
        default_prompt = "car, person, tree, cloud, building"
        user_prompt = request.GET.get('prompt', default_prompt)
        print(f"DEBUG: Step 1 - Detecting [{user_prompt}] with YOLO-World...")
        

        custom_classes = [x.strip() for x in user_prompt.split(',')]
        detector.set_classes(custom_classes)
        
    
        detect_results = detector.predict(image_path, conf=0.15, iou=0.5)
        det_result = detect_results[0]
        
        new_annotations = []

        if det_result.boxes:
            print(f"DEBUG: Step 2 - Found {len(det_result.boxes)} boxes. Refining with SAM...")
            
            bboxes = det_result.boxes.xyxy 

            seg_results = segmenter(image_path, bboxes=bboxes)
            seg_result = seg_results[0]

            if seg_result.masks:
                for i, mask in enumerate(seg_result.masks.xy):
                    

                    if len(mask) < 3: continue

                    points = [{'x': float(pt[0]), 'y': float(pt[1])} for pt in mask]
                    
                    cls_id = int(det_result.boxes.cls[i].item())
                    if cls_id < len(custom_classes):
                        label_name = custom_classes[cls_id]
                    else:
                        label_name = "object"

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

        print(f"DEBUG: Success! Generated {len(new_annotations)} polygons.")
        return JsonResponse({'success': True, 'annotations': new_annotations})

    except Exception as e:
        print(f"AI Error: {e}")
        return JsonResponse({'error': str(e)}, status=500)


@csrf_exempt
def save_all_data(request, image_id):
    if request.method == 'POST':
        try:
            img_obj = get_object_or_404(AnnotatedImage, id=image_id)
            req_data = json.loads(request.body)

            full_overlay_url = ""
            if 'full_overlay_data' in req_data and req_data['full_overlay_data']:
                format, imgstr = req_data['full_overlay_data'].split(';base64,') 
                ext = format.split('/')[-1]
                filename = f"full_overlay_{image_id}.{ext}"
                
                img_obj.annotated_file.save(filename, ContentFile(base64.b64decode(imgstr)), save=False)
                full_overlay_url = img_obj.annotated_file.url

            processed_annotations = []
            input_annotations = req_data.get('annotations_data', [])

            mask_dir = os.path.join(settings.MEDIA_ROOT, 'individual_masks')
            os.makedirs(mask_dir, exist_ok=True)

            for index, item in enumerate(input_annotations):
                mask_url = ""
                
                raw_label = item.get('label', 'unknown')
                safe_label = re.sub(r'[^a-zA-Z0-9]', '_', raw_label).lower()

                if 'mask_base64' in item and item['mask_base64']:
                    format, imgstr = item['mask_base64'].split(';base64,')
                    ext = format.split('/')[-1]
                    
                    mask_filename = f"mask_{image_id}_{index}_{safe_label}.{ext}"
                    file_path = os.path.join(mask_dir, mask_filename)
                    
                    with open(file_path, "wb") as f:
                        f.write(base64.b64decode(imgstr))
                    
                    mask_url = f"{settings.MEDIA_URL}individual_masks/{mask_filename}"

                coords = item.get('coordinates', {})
                points = item.get('points', []) 
                shape_type = item.get('type', 'polygon')

                entry = {
                    "label": raw_label,
                    "type": shape_type,
                    "masked_image": mask_url,
                    "coordinates": {
                        "x": coords.get('x', 0),
                        "y": coords.get('y', 0),
                        "width": coords.get('width', 0),
                        "height": coords.get('height', 0)
                    },
                    "points": points 
                }
                processed_annotations.append(entry)

            final_json = {
                "id": img_obj.id,
                "original_image": img_obj.image.url,
                "original_fully_masked_image": full_overlay_url,
                "imagewidth": req_data.get('width'),
                "imageheight": req_data.get('height'),
                "annotations": processed_annotations
            }

            img_obj.annotations = json.dumps(final_json)
            img_obj.save()

            return JsonResponse({'success': True, 'data': final_json})

        except Exception as e:
            print(f"Error saving data: {e}")
            return JsonResponse({'error': str(e)}, status=500)

    return JsonResponse({'error': 'Invalid request'}, status=400)