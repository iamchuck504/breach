import bpy
from pathlib import Path
root=Path(__file__).resolve().parents[3]
scene=bpy.data.scenes['Breach_Corner_Coffee_Study']; bpy.context.window.scene=scene
objects=[o for o in scene.objects if o.type in {'MESH','FONT'} and o.name!='Presentation pavement']
bpy.ops.object.select_all(action='DESELECT')
for o in objects:o.select_set(True)
bpy.context.view_layer.objects.active=objects[0]
bpy.ops.object.convert(target='MESH')
# Merge material batches offline; hundreds of brick objects must not become draw calls.
keep={'Existing envelope','Roof cap','Sign brass frame','Sign enamel inset','CORNER COFFEE','ROASTED DAILY  /  EST. 1984'}
batches={}
for o in list(bpy.context.selected_objects):
    if o.name not in keep:batches.setdefault(o.data.materials[0].name,[]).append(o)
for name,items in batches.items():
    bpy.ops.object.select_all(action='DESELECT')
    for o in items:o.select_set(True)
    bpy.context.view_layer.objects.active=items[0]
    bpy.ops.object.join();bpy.context.object.name='Cafe '+name
bpy.ops.object.select_all(action='DESELECT')
for o in scene.objects:
    if o.type=='MESH' and o.name!='Presentation pavement':o.select_set(True)
out=root/'public/assets/calle/corner-coffee.glb'
bpy.ops.export_scene.gltf(filepath=str(out),use_selection=True,export_apply=True)
print('CAFE EXPORT',out, len(bpy.context.selected_objects))
