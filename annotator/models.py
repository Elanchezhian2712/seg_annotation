from django.db import models
import json

class AnnotatedImage(models.Model):
    image = models.ImageField(upload_to='images/')
    annotations = models.TextField(blank=True, null=True)
    uploaded_at = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        return self.image.name

    def set_annotations(self, data):
        self.annotations = json.dumps(data)

    def get_annotations(self):
        if self.annotations:
            return json.loads(self.annotations)
        return []