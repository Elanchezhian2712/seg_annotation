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

# --- EXPORT: YOLO FORMAT (Segmentation) ---
def export_yolo(request):
    all_images = AnnotatedImage.objects.exclude(annotations__isnull=True).exclude(annotations__exact='')
    
    class_map = {}
    class_id_counter = 0
    
    zip_buffer = io.BytesIO()
    
    with zipfile.ZipFile(zip_buffer, 'w') as zf:
        
        for img_obj in all_images:
            try:
                data = json.loads(img_obj.annotations)
                if not data: continue
                
                with img_obj.image.open() as pil_img:
                    img_w, img_h = pil_img.width, pil_img.height

                yolo_lines = []
                
                for ann in data:
                    label = ann.get('label', 'default').lower().strip()
                    
                    if label not in class_map:
                        class_map[label] = class_id_counter
                        class_id_counter += 1
                    
                    cls_id = class_map[label]
                    points = get_polygon_points(ann)
                    
                    normalized_points = []
                    for pt in points:
                        nx = max(0, min(1, pt[0] / img_w)) 
                        ny = max(0, min(1, pt[1] / img_h))
                        normalized_points.extend([f"{nx:.6f}", f"{ny:.6f}"])
                    
                    if normalized_points:
                        line = f"{cls_id} " + " ".join(normalized_points)
                        yolo_lines.append(line)
                
                txt_filename = os.path.splitext(os.path.basename(img_obj.image.name))[0] + ".txt"
                zf.writestr(txt_filename, "\n".join(yolo_lines))
                
            except Exception as e:
                print(f"Skipping image {img_obj.id}: {e}")

        classes_content = "\n".join([k for k, v in sorted(class_map.items(), key=lambda item: item[1])])
        zf.writestr("classes.txt", classes_content)

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
    class_id_counter = 1
    ann_id_counter = 1
    
    # Get all images that have annotations
    all_db_images = AnnotatedImage.objects.exclude(annotations__isnull=True)

    for img_obj in all_db_images:
        try:
            # Load your CUSTOM JSON structure
            db_data = json.loads(img_obj.annotations)
            
            # 1. Setup Image Info
            # Note: Your JSON stores width/height as "imagewidth", check keys carefully
            width = db_data.get('imagewidth', 100)
            height = db_data.get('imageheight', 100)
            
            image_info = {
                "id": img_obj.id,
                "file_name": os.path.basename(img_obj.image.name),
                "width": width,
                "height": height
            }
            images.append(image_info)
            
            # 2. Loop through YOUR "annotations" list
            annot_list = db_data.get('annotations', [])
            
            for ann in annot_list:
                label = ann.get('label', 'unknown').lower().strip()
                
                # Handle Categories
                if label not in class_map:
                    class_map[label] = class_id_counter
                    categories.append({"id": class_id_counter, "name": label, "supercategory": "none"})
                    class_id_counter += 1
                
                # Get Coordinates (Bounding Box)
                coords = ann.get('coordinates', {})
                x = coords.get('x', 0)
                y = coords.get('y', 0)
                w = coords.get('width', 0)
                h = coords.get('height', 0)

                # Get Segmentation (Points)
                points_data = ann.get('points', [])
                segmentation = []
                
                # Convert [{x:1, y:1}, {x:2, y:2}] -> [1, 1, 2, 2]
                if points_data:
                    for pt in points_data:
                        segmentation.extend([pt['x'], pt['y']])
                else:
                    # If no points (e.g. Rectangle), make a box polygon
                    segmentation = [
                        x, y, 
                        x+w, y, 
                        x+w, y+h, 
                        x, y+h
                    ]

                coco_ann = {
                    "id": ann_id_counter,
                    "image_id": img_obj.id,
                    "category_id": class_map[label],
                    "segmentation": [segmentation],
                    "area": w * h,
                    "bbox": [x, y, w, h],
                    "iscrowd": 0
                }
                annotations.append(coco_ann)
                ann_id_counter += 1

        except Exception as e:
            print(f"Error processing image {img_obj.id}: {e}")

    coco_output = {
        "info": {"description": "Custom Dataset"},
        "images": images,
        "annotations": annotations,
        "categories": categories
    }

    response = HttpResponse(json.dumps(coco_output, indent=4), content_type='application/json')
    response['Content-Disposition'] = 'attachment; filename="coco_annotations.json"'
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