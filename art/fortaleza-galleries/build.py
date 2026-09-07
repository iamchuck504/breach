"""Gallery geometry generated from the same manifest as server collision.
Run node scripts/build-fort-galleries.mjs, not this file independently.
"""
import bpy,json,math
from pathlib import Path
HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[1]
data=json.loads((HERE/'layout.json').read_text());g=data['dimensions']
bpy.ops.wm.read_factory_settings(use_empty=True)
def material(name,color,metal=0):
    m=bpy.data.materials.new(name);m.diffuse_color=(*color,1);m.use_nodes=True
    p=m.node_tree.nodes['Principled BSDF'];p.inputs['Base Color'].default_value=(*color,1)
    p.inputs['Roughness'].default_value=.86;p.inputs['Metallic'].default_value=metal
    return m
stone=material('Aged fortress limestone',(.30,.27,.215))
trim=material('Dressed window stone',(.46,.405,.31))
roof=material('Weathered terracotta',(.22,.095,.038))
joint=material('Recessed mortar',(.17,.15,.115))
wood=material('Dark structural oak',(.08,.05,.027))
def box(name,x,y,z,w,h,d,mat):
    vertices=[(x+sx*w/2,-z+sz*d/2,y+sy*h/2) for sx,sz,sy in
              [(-1,-1,-1),(1,-1,-1),(1,1,-1),(-1,1,-1),(-1,-1,1),(1,-1,1),(1,1,1),(-1,1,1)]]
    mesh=bpy.data.meshes.new(name);mesh.from_pydata(vertices,[],[(0,3,2,1),(4,5,6,7),(0,1,5,4),(1,2,6,5),(2,3,7,6),(3,0,4,7)])
    o=bpy.data.objects.new(name,mesh);bpy.context.collection.objects.link(o)
    o.data.materials.append(mat);return o
for i,b in enumerate(data['boxes']):
    bottom=b.get('visualBase',b.get('minY',0));height=b['h']-bottom
    mat=roof if b.get('roof') else stone
    box('Roof tiles' if b.get('roof') else 'Stair tread' if b.get('walkSurface') else 'Gallery masonry',
        b['x'],bottom+height/2,b['z'],b['w'],height,b['d'],mat)
    if b.get('walkSurface') and not b.get('deck'):
        box('Dressed stair nosing',b['x'],b['h']+.002,b['z'],b['w']-.03,.004,b['d']*.30,trim)
    elif b.get('deck'):
        for z in range(-int(g['top'])+1,int(g['top'])):box('Gallery floor paving',b['x'],3.003,z,b['w'],.006,.014,joint)
        for dx in (-.95,.95):box('Gallery floor paving',b['x']+dx,3.003,0,.014,.006,g['top']*2,joint)
    elif b.get('roof'):
        # Tile seams lie on the actual roof band, not a coplanar overlay.
        for z in range(-int(g['end']),int(g['end'])+1):box('Tile course',b['x'],b['h']+.004,z,b['w']-.005,.008,.018,joint)
    elif b['d']>6:
        for y in [bottom+.38+j*.40 for j in range(int(height/.40))]:
            if y>=b['h']-.05:continue
            for side in (-1,1):box('Masonry horizontal joint',b['x']+side*(b['w']/2+.003),y,b['z'],.006,.014,b['d'],joint)
        if b['w']<1:
            for row in range(int(height/.40)):
                for z in range(math.ceil(b['z']-b['d']/2),math.floor(b['z']+b['d']/2)):
                    zz=z+(row%2)*.5
                    if zz>b['z']+b['d']/2-.05:continue
                    for side in (-1,1):box('Masonry vertical joint',b['x']+side*(b['w']/2+.003),bottom+row*.40+.20,zz,.006,.37,.014,joint)
for side in (-1,1):
    # Full-size framed open windows. No glass or false black planes.
    for i in range(-g['windowRadius'],g['windowRadius']+1):
        z=i*3
        for y in (4.10,5.59):box('Window lintel and sill',side*21.38,y,z,.85,.07,2.44,trim)
        for dz in (-1.20,1.20):box('Window jamb',side*21.38,4.85,z+dz,.85,1.50,.075,trim)
        box('Roof beam',side*g['x'],5.96,z,g['width'],.08,.13,wood)
    # Frame the four real ground entrances without blocking their clear width.
    for end in (-1,1):
        for z in (g['start']+.01,g['end']-.02):box('Stair entrance jamb',side*21.40,1.49,end*z,.85,2.98,.075,trim)
        box('Stair entrance lintel',side*21.40,3.04,end*(g['start']+g['end'])/2,.85,.08,g['end']-g['start'],trim)
bpy.ops.wm.save_as_mainfile(filepath=str(HERE/'fortaleza-galleries.blend'))
# Material batching after editable source saved.
groups={}
for o in list(bpy.context.scene.objects):
    if o.type=='MESH':groups.setdefault(o.data.materials[0].name,[]).append(o)
for name,objects in groups.items():
    bpy.ops.object.select_all(action='DESELECT')
    for o in objects:o.select_set(True)
    bpy.context.view_layer.objects.active=objects[0];bpy.ops.object.join();bpy.context.object.name=name
bpy.ops.export_scene.gltf(filepath=str(ROOT/'public/assets/calle/fortaleza-galleries.glb'),export_format='GLB',export_yup=True)
