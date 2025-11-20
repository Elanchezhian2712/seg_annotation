# seg_annotation

Python 3.10 (Must match your version).

python -m venv seg_env
.\seg_env\Scripts\activate


mkdir wheels


pip download torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu121 -d ./wheels

pip wheel "git+https://github.com/facebookresearch/detectron2.git" --no-deps -w ./wheels

pip install "git+https://github.com/ultralytics/CLIP.git"

pip wheel mmengine -w ./wheels
pip wheel mmcv>=2.0.0 -w ./wheels
pip wheel mmsegmentation>=1.0.0 -w ./wheels
