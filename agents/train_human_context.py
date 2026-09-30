"""Fit a small action-kind model to causal public context from our own battles."""
import copy
import json
import sys
from pathlib import Path
import torch

torch.set_num_threads(1)
torch.manual_seed(1350)
source, output = map(Path, sys.argv[1:3])
data = json.loads(source.read_text())
validation_rooms = set(data['rooms'][-60:])
train = [r for r in data['rows'] if r['room'] not in validation_rooms]
valid = [r for r in data['rows'] if r['room'] in validation_rooms]
if not train or not valid:
    raise ValueError('Both room-separated splits need examples')
x = torch.tensor([r['features'] for r in train], dtype=torch.float32)
y = torch.tensor([r['label'] for r in train], dtype=torch.long)
vx = torch.tensor([r['features'] for r in valid], dtype=torch.float32)
vy = torch.tensor([r['label'] for r in valid], dtype=torch.long)
model = torch.nn.Sequential(torch.nn.Linear(x.shape[1], 32), torch.nn.Tanh(), torch.nn.Linear(32, 5))
optimizer = torch.optim.AdamW(model.parameters(), lr=0.003, weight_decay=0.03)
best_loss = float('inf')
best = None
best_epoch = 0
for epoch in range(100):
    order = torch.randperm(len(x))
    for ix in order.split(64):
        loss = torch.nn.functional.cross_entropy(model(x[ix]), y[ix])
        optimizer.zero_grad(); loss.backward(); optimizer.step()
    with torch.no_grad():
        val_loss = torch.nn.functional.cross_entropy(model(vx), vy).item()
    if val_loss < best_loss:
        best_loss, best, best_epoch = val_loss, copy.deepcopy(model.state_dict()), epoch
    if epoch - best_epoch >= 12:
        break
model.load_state_dict(best)
counts = torch.bincount(y, minlength=5).float() + 1
prior = counts / counts.sum()
cells = {}
for r in train:
    cells.setdefault(r['bucket'], torch.zeros(5))[r['label']] += 1
baseline = torch.stack([(cells.get(r['bucket'], torch.zeros(5)) + 30 * prior) /
                        (cells.get(r['bucket'], torch.zeros(5)).sum() + 30) for r in valid])
baseline_loss = -baseline[torch.arange(len(valid)), vy].log().mean().item()
with torch.no_grad():
    probabilities = model(vx).softmax(-1)
    predicted = probabilities.argmax(-1)
result = {'features': data['features'], 'kinds': data['kinds'], 'hidden': 32,
          'w1': model[0].weight.tolist(), 'b1': model[0].bias.tolist(),
          'w2': model[2].weight.tolist(), 'b2': model[2].bias.tolist(),
          'validation': {'trainRows': len(train), 'validationRows': len(valid),
                         'trainRooms': len(data['rooms']) - 60, 'validationRooms': 60,
                         'epoch': best_epoch, 'nll': best_loss, 'bucketBaselineNll': baseline_loss,
                         'accuracy': (predicted == vy).float().mean().item()},
          'validationRooms': sorted(validation_rooms)}
output.write_text(json.dumps(result) + '\n')
print(json.dumps(result['validation']))
