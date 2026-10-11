
from pathlib import Path
import onnx

model_path = Path(__file__).parent / "model" / "model.onnx"
model = onnx.load(str(model_path))

print("File size:", model_path.stat().st_size, "bytes")
print("Producer:", model.producer_name)
print("Number of graph nodes:", len(model.graph.node))
print("Number of initializers:", len(model.graph.initializer))

print("\nGraph nodes:")
for node in model.graph.node:
    print(node.op_type, "->", node.output)

onnx.checker.check_model(model)
print("\nONNX structure is valid.")
