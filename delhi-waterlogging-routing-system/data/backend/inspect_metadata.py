
from pathlib import Path
import onnxruntime as ort

model_path = Path(__file__).parent / "model" / "model.onnx"

session = ort.InferenceSession(str(model_path))
metadata = session.get_modelmeta()

print("Description:", metadata.description)
print("Graph name:", metadata.graph_name)
print("Producer:", metadata.producer_name)
print("Version:", metadata.version)
print("Custom metadata:", metadata.custom_metadata_map)
