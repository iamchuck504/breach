"""Package approved native skeleton/clips and six weapon meshes for Breach."""
import bpy,sys,json,math
from pathlib import Path
from mathutils import Matrix, Vector
args=sys.argv[sys.argv.index('--')+1:]
if len(args)!=2:raise SystemExit('Expected output directory and refined weapons .blend path')
WEAPONS=Path(args[1])
if not WEAPONS.is_file():raise FileNotFoundError(WEAPONS)
OUT=Path(args[0]);OUT.mkdir(parents=True,exist_ok=True)
s=bpy.context.scene
r=next(o for o in s.objects if o.type=='ARMATURE' and 'BLUE' not in o.name)
body=next(o for o in s.objects if o.type=='MESH' and not o.name.startswith('Equipped')
          and any(m.type=='ARMATURE' and m.object==r for m in o.modifiers))
r.location=(0,0,0);r.animation_data.action=None
for t in list(r.animation_data.nla_tracks):
    if not t.name.startswith('SMG_Anatomical_'):r.animation_data.nla_tracks.remove(t)
    else:t.mute=True
# Only this scene is exported. Keep original source blend untouched.
clean=bpy.data.scenes.new('Native runtime package');clean.collection.objects.link(r);clean.collection.objects.link(body)
clean.render.fps=60;bpy.context.window.scene=clean
for o in bpy.data.objects:o.select_set(False)
r.select_set(True);body.select_set(True);bpy.context.view_layer.objects.active=r
bpy.ops.export_scene.gltf(filepath=str(OUT/'soldier-native.glb'),export_format='GLB',
    use_selection=True,use_active_scene=True,export_animations=True,export_animation_mode='NLA_TRACKS',export_skins=True)
print('Native body and ten approved clips exported')
# Mesh parts in the art workbench already include equipped scaling. Convert
# workbench coordinates (game.z,game.x,game.y) back to game-local axes, then
# to Blender export axes. Merge by material on export via a joined mesh.
with bpy.data.libraries.load(str(WEAPONS),link=False) as (a,b):
    b.collections=['04 REFINED - concept pass']
lib=b.collections[0]
clean.collection.children.link(lib)
report={}
for key in ('smg','shotgun','pistol','sniper','bazooka','grenade'):
    root=next(o for o in lib.objects if o.type=='EMPTY' and o.name.startswith(key+' - REFINED'))
    objs=[]
    for src in root.children:
        if src.type!='MESH':continue
        ev=src.evaluated_get(bpy.context.evaluated_depsgraph_get())
        mesh=bpy.data.meshes.new_from_object(ev)
        # source vertices may have a local basis; presentation root is ignored.
        C=Matrix(((0,1,0,0),(-1,0,0,0),(0,0,1,0),(0,0,0,1)))
        mesh.transform(C@src.matrix_basis)
        o=bpy.data.objects.new('runtime_'+key,mesh);clean.collection.objects.link(o);objs.append(o)
    for o in bpy.data.objects:o.select_set(False)
    for o in objs:o.select_set(True)
    bpy.context.view_layer.objects.active=objs[0];bpy.ops.object.join()
    weapon=bpy.context.object;weapon.name=key
    # Capture unchanged original reference sockets in GAME coordinates.
    sockets={}
    for o in root.children:
        if 'SOCKET ' in o.name:
            name=o.name.split('SOCKET ')[1].split('.')[0]
            v=o.matrix_basis.translation;sockets[name]=[v.y,v.z,v.x]
    weapon['sockets']=sockets
    bpy.ops.export_scene.gltf(filepath=str(OUT/(key+'.glb')),export_format='GLB',
        use_selection=True,use_active_scene=True,export_animations=False,export_extras=True)
    report[key]={'sockets':sockets,'vertices':len(weapon.data.vertices)}
    weapon.select_set(False)
(OUT/'weapons.json').write_text(json.dumps(report,indent=2))
print(json.dumps(report))
