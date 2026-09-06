"""Export approved armor as rigid gameplay segments; never edit the source blend.

The live procedural rig remains animation/weapon authority. Full Blender clips
remain in the cover-ready source until they have gameplay state adapters.
"""
import bpy, math, json, sys
from pathlib import Path
from mathutils import Vector, Matrix

OUT = Path(sys.argv[sys.argv.index('--') + 1])
OUT.mkdir(parents=True, exist_ok=True)
scene = bpy.context.scene
rig = next(o for o in scene.objects if o.type == 'ARMATURE' and 'BLUE' not in o.name)
body = next(o for o in scene.objects if o.type == 'MESH' and not o.name.startswith('Equipped')
            and any(m.type == 'ARMATURE' and m.object == rig for m in o.modifiers))
# Blender -Y forward -> game -Z forward; this is a rotation, NOT a reflection.
C = Matrix(((-1,0,0),(0,0,1),(0,1,0)))
vertices = [C @ v.co for v in body.data.vertices]
groups = {g.index:g.name for g in body.vertex_groups}
tags = [groups[max(v.groups, key=lambda g:g.weight).group] for v in body.data.vertices]
parts = {}
for face in body.data.polygons:
    names = [tags[i] for i in face.vertices]
    name = max(set(names), key=names.count)
    if name in ('weapon', 'magazine', 'root'): continue
    parts.setdefault(name, []).append(face)
exports=[]
for name, faces in parts.items():
    bone=rig.data.bones[name]
    anchor=C @ bone.head_local
    rotation=Matrix.Identity(3); stretch=1.; offset=Vector((0,0,0))
    target=name
    if name=='chest': anchor=C @ rig.data.bones['pelvis'].head_local;target='torso'
    elif name=='pelvis': target='torso'
    elif name.startswith(('upper_arm.','forearm.','thigh.','shin.')):
        direction=C @ (bone.tail_local-bone.head_local)
        rotation=direction.rotation_difference(Vector((0,-1,0))).to_matrix()
        length=.28 if name.startswith('upper_arm') else .31 if name.startswith('forearm') else .32
        stretch=length/direction.length
    elif name.startswith('pauldron.'):
        anchor=C @ rig.data.bones['upper_arm.'+name[-1]].head_local
    elif name.startswith('kneecap.'):target='shin.'+name[-1]
    elif name.startswith('foot.'):
        target='shin.'+name[-1];offset.y=-.32
    if name.startswith(('thigh.','shin.','kneecap.','foot.')):
        offset.x += .06 if name.endswith('.R') else -.06
    ids=sorted({i for f in faces for i in f.vertices}); lookup={v:i for i,v in enumerate(ids)}
    if name.startswith('hand.'):
        # The runtime hand node is the grip CENTER, not the authored wrist.
        anchor=sum((vertices[i] for i in ids),Vector())/len(ids)
        forearm=rig.data.bones['forearm.'+name[-1]]
        rotation=(C@(forearm.tail_local-forearm.head_local)).rotation_difference(Vector((0,-1,0))).to_matrix()
    coords=[]
    for i in ids:
        v=rotation@(vertices[i]-anchor);v.y*=stretch;v+=offset
        # Exporter converts Blender axes, so convert game coordinates back.
        coords.append((v.x,-v.z,v.y))
    mesh=bpy.data.meshes.new('Runtime '+name)
    mesh.from_pydata(coords,[],[[lookup[i] for i in f.vertices] for f in faces])
    for slot in body.material_slots:mesh.materials.append(slot.material)
    for dst,src in zip(mesh.polygons,faces):dst.material_index=src.material_index;dst.use_smooth=src.use_smooth
    obj=bpy.data.objects.new('segment_'+name.replace('.','_'),mesh);scene.collection.objects.link(obj)
    obj['runtimeTarget']=target;exports.append(obj)
for o in scene.objects:o.select_set(False)
clean=bpy.data.scenes.new('Runtime export only')
for o in exports:clean.collection.objects.link(o)
bpy.context.window.scene=clean
for o in exports:o.select_set(True)
bpy.context.view_layer.objects.active=exports[0]
bpy.ops.export_scene.gltf(filepath=str(OUT/'soldier-blender-body.glb'),export_format='GLB',
    use_selection=True,use_active_scene=True,export_animations=False,export_extras=True)
print(json.dumps({'segments':len(exports),'faces':sum(len(o.data.polygons) for o in exports),
    'source':body.name,'targets':[o['runtimeTarget'] for o in exports]}))
