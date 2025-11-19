from django.shortcuts import render, get_object_or_404
from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt
from django.conf import settings
from .models import AnnotatedImage
import json
import os

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