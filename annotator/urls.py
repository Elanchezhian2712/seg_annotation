from django.urls import path
from . import views

urlpatterns = [
    path('', views.index, name='index'),
    path('upload/', views.upload_image, name='upload_image'),
    path('save/<int:image_id>/', views.save_annotations, name='save_annotations'),
]