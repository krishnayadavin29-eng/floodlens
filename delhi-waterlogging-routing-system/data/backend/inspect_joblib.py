
from pathlib import Path
import joblib

model_path = (
    Path(__file__).resolve().parent
    / "model"
    / "waterlogging_model.joblib"
)

print("Loading:", model_path)

obj = joblib.load(model_path)

print("\nObject type:", type(obj))
print("\nObject details:")

if hasattr(obj, "feature_names_in_"):
    print("Feature names:")
    print(list(obj.feature_names_in_))

if hasattr(obj, "n_features_in_"):
    print("Number of input features:", obj.n_features_in_)

if hasattr(obj, "named_steps"):
    print("\nPipeline steps:")
    for name, step in obj.named_steps.items():
        print(name, "->", type(step).__name__)

if hasattr(obj, "classes_"):
    print("\nClass labels:", obj.classes_)

if hasattr(obj, "get_params"):
    print("\nModel parameters:")
    print(obj.get_params())

print("\nInspection finished.")
