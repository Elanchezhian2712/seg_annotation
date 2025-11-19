from django.urls import path
from . import views

urlpatterns = [
    path('', views.index, name='index'),
    path('upload/', views.upload_image, name='upload_image'),
    path('save/<int:image_id>/', views.save_annotations, name='save_annotations'),

    path('export/yolo/', views.export_yolo, name='export_yolo'),
    path('export/coco/', views.export_coco, name='export_coco'),
    path('auto-detect/<int:image_id>/', views.auto_detect, name='auto_detect'),
]