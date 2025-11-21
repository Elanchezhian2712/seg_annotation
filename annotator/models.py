from django.db import models
import json

class AnnotatedImage(models.Model):
    image = models.ImageField(upload_to='images/')
    annotations = models.TextField(blank=True, null=True)
    uploaded_at = models.DateTimeField(auto_now_add=True)
    mask_file = models.ImageField(upload_to='masks/', blank=True, null=True)
    annotated_file = models.ImageField(upload_to='annotated_output/', blank=True, null=True)

    def __str__(self):
        return self.image.name
    
    def __str__(self):
        return f"Image {self.id}"

    def set_annotations(self, data):
        self.annotations = json.dumps(data)

    def get_annotations(self):
        if self.annotations:
            return json.loads(self.annotations)
        return []