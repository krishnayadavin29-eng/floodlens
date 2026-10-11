
from pathlib import Path
import onnxruntime as ort

# Locate model.onnx relative to this file.
MODEL_PATH = (
    Path(__file__).resolve().parent
    / "model"
    / "model.onnx"
)

print("Model path:", MODEL_PATH)

if not MODEL_PATH.exists():
    raise FileNotFoundError(
        "model.onnx was not found. "
        "Check that it is inside backend/model/"
    )

# Load the ONNX model.
session = ort.InferenceSession(
    str(MODEL_PATH),
    providers=["CPUExecutionProvider"]
)

print("\nModel loaded successfully!")

print("\n--- INPUT INFORMATION ---")
for item in session.get_inputs():
    print("Name:", item.name)
    print("Shape:", item.shape)
    print("Type:", item.type)
    print()

print("--- OUTPUT INFORMATION ---")
for item in session.get_outputs():
    print("Name:", item.name)
    print("Shape:", item.shape)
    print("Type:", item.type)
    print()
