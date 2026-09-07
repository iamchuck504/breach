"""Static castle dressing, metres / game Y up. No gameplay volumes.
Blender source retains named pieces; exported meshes are material-batched.
"""
import bpy, math, random, json
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
bpy.ops.wm.read_factory_settings(use_empty=True)
random.seed(17)
def material(name,c,metal=0,emit=0):
    m=bpy.data.materials.new(name);m.diffuse_color=(*c,1);m.use_nodes=True
    p=m.node_tree.nodes['Principled BSDF'];p.inputs['Base Color'].default_value=(*c,1)
    p.inputs['Roughness'].default_value=.82;p.inputs['Metallic'].default_value=metal
    p.inputs['Emission Color'].default_value=(*c,1);p.inputs['Emission Strength'].default_value=emit
    return m
stone=material('Limestone',(.34,.31,.25));trim=material('Carved pale stone',(.53,.47,.35))
dark=material('Recessed mortar and arrow slits',(.075,.081,.074))
iron=material('Forged iron',(.055,.065,.060),.65)
gold=material('Aged brass heraldry',(.49,.29,.09),.55)
red=material('Crimson enamel',(.40,.038,.024));blue=material('Cobalt enamel',(.025,.13,.40))
fire=material('Amber embers',(.95,.24,.025),0,2)
def box(name,x,y,z,w,h,d,mat,angle=0,bevel=0):
    verts=[(sx*w/2,sz*d/2,sy*h/2) for sx,sz,sy in
           [(-1,-1,-1),(1,-1,-1),(1,1,-1),(-1,1,-1),(-1,-1,1),(1,-1,1),(1,1,1),(-1,1,1)]]
    mesh=bpy.data.meshes.new(name);mesh.from_pydata(verts,[],[(0,3,2,1),(4,5,6,7),(0,1,5,4),(1,2,6,5),(2,3,7,6),(3,0,4,7)])
    o=bpy.data.objects.new(name,mesh);bpy.context.collection.objects.link(o)
    o.location=(x,-z,y);o.rotation_euler.z=-angle;o.data.materials.append(mat)
    if bevel:
        b=o.modifiers.new('Hand dressed edge','BEVEL');b.width=bevel;b.segments=1
    return o
def cylinder(name,x,y,z,r,h,mat,r2=None,n=16):
    bpy.ops.mesh.primitive_cone_add(vertices=n,radius1=r,radius2=r if r2 is None else r2,depth=h,location=(x,-z,y))
    o=bpy.context.object;o.name=name;o.data.materials.append(mat);return o
def prism(name,outline,depth,mat):
    # World-coordinate polygon with thickness in Z.
    verts=[(x,-(z+t),y) for t in (-depth/2,depth/2) for x,y,z in outline];n=len(outline)
    faces=[tuple(range(n-1,-1,-1)),tuple(range(n,n*2))]+[(i,(i+1)%n,(i+1)%n+n,i+n) for i in range(n)]
    mesh=bpy.data.meshes.new(name);mesh.from_pydata(verts,[],faces);mesh.materials.append(mat)
    o=bpy.data.objects.new(name,mesh);bpy.context.collection.objects.link(o)
# Four existing tower envelopes, unchanged radius/height. Stone courses and
# radial joints sit on the surface; crowns replace the old simple cubes.
for x in (-23.6,23.6):
 for z in (-29.2,29.2):
    cylinder('Tower masonry drum',x,3.75,z,2.35,8.5,stone,2.05)
    for y,r in ((.18,2.32),(1.15,2.30),(4.5,2.19),(7.65,2.08)):
        cylinder('Dressed tower belt',x,y,z,r+.045,.14,trim,n=16)
    for row in range(14):
        y=.48+row*.51;r=2.35-(y+.5)/8.5*.30
        cylinder('Recessed horizontal course',x,y,z,r+.004,.017,dark)
        for i in range(12):
            a=(i+(row%2)*.5)*math.tau/12
            box('Stone vertical joint',x+math.sin(a)*r,y+.24,z+math.cos(a)*r,.018,.45,.012,dark,a)
    cylinder('Crown coping',x,7.97,z,2.10,.10,trim)
    for i in range(10):
        a=i*math.tau/10
        box('Battlement merlon',x+math.sin(a)*2,8.27,z+math.cos(a)*2,.80,.55,.95,stone,a,.045)
        box('Merlon cap',x+math.sin(a)*2,8.49,z+math.cos(a)*2,.80,.08,.95,trim,a,.015)
    # Arrow slits on inward-facing facets, not rectangular floating windows.
    for a in (math.atan2(-x,-z)-.48,math.atan2(-x,-z)+.48):
      for y in (3.1,5.3):
        r=2.35-(y+.5)/8.5*.30
        box('Arrow slit recess',x+math.sin(a)*(r+.015),y,z+math.cos(a)*(r+.015),.13,.86,.025,dark,a)
        for dx in (-.14,.14):
            box('Arrow slit dressed jamb',x+math.sin(a)*(r+.018)+math.cos(a)*dx,y,z+math.cos(a)*(r+.018)-math.sin(a)*dx,.11,.96,.04,trim,a,.01)
# Wall and gate-shield merlons: original placements and silhouette.
points=[]
x=-20.6
while x<=21:
    points.extend([(x,-27,0),(x,27,0)]);x+=1.7
z=-26.2
while z<=26.6:
    if abs(z)>=18.5:points.extend([(-21.4,z,math.pi/2),(21.4,z,math.pi/2)])
    z+=1.7
x=-3.2
while x<=3.3:
    points.extend([(x,-20.9,0),(-x,20.9,0)]);x+=1.6
for x,z,a in points:
    box('Wall battlement',x,3.27,z,.8,.55,.95,stone,a,.035)
    box('Pale battlement coping',x,3.49,z,.8,.08,.95,trim,a,.012)
# Real sculpted shields replace flat banner placeholders on spawn walls.
for sign,mat in ((-1,red),(1,blue)):
 for x in (-2.4,2.4):
    z=sign*20.33
    outline=[(x-.48,2.63,z),(x+.48,2.63,z),(x+.43,1.33,z),(x,.82,z),(x-.43,1.33,z)]
    prism('Forged shield rim',outline,.06,iron)
    outline=[(x+(xx-x)*.86,1.76+(yy-1.76)*.86,zz-sign*.041) for xx,yy,zz in outline]
    prism('Faction shield field',outline,.012,mat)
    box('Heraldic blade',x,1.86,z-sign*.055,.075,1.12,.016,gold)
    box('Heraldic crossguard',x,2.02,z-sign*.060,.48,.075,.016,gold)
    for dx in (-.28,.28):
        cylinder('Shield crest rivet',x+dx,2.39,z-sign*.06,.035,.03,gold,n=8)
# Brazier baskets sit on the existing high pillars. No new floor clutter.
for x,z in ((7,-6),(-7,6),(-11,-5),(11,5)):
    cylinder('Brazier foot',x,3.035,z,.20,.07,iron)
    cylinder('Hammered fire bowl',x,3.14,z,.20,.20,iron,.30)
    cylinder('Visible glowing coals',x,3.245,z,.24,.028,fire)
    for y in (3.29,3.51):
        bpy.ops.mesh.primitive_torus_add(major_segments=12,minor_segments=4,location=(x,-z,y),major_radius=.26,minor_radius=.018)
        bpy.context.object.name='Brazier hoop';bpy.context.object.data.materials.append(iron)
    for i in range(8):
        a=i*math.tau/8;box('Basket upright',x+math.sin(a)*.26,3.38,z+math.cos(a)*.26,.026,.30,.026,iron)
    for dx,dz,h in ((0,0,.40),(.09,.04,.25),(-.08,-.04,.29)):
        cylinder('Small flame tongue',x+dx,3.24+h/2,z+dz,.065,h,fire,0,n=5)
# Gallery upper lintels: radial carving ABOVE clear window opening, never
# narrowing a firing aperture. Segmented crest and keystone, no fake glass.
for side in (-1,1):
 for z in (-6,-3,0,3,6):
    for j in range(9):
        zz=z+(j-4)*.265
        box('Gallery carved lintel stone',side*20.955,5.80,zz,.035,.26,.25,trim,bevel=.012)
    box('Gallery lintel keystone',side*20.925,5.80,z,.06,.31,.19,stone,bevel=.012)
# Cut-stone faces on the existing courtyard cover. The collider manifest
# determines every backing plane; shallow relief never creates new cover.
layout=ROOT/'art/fortress-kit/layout.json'
if layout.exists():
 for b in json.loads(layout.read_text()):
    if b.get('visual') is False or b.get('style')=='wall':continue
    for sign in ([1,-1] if b.get('mirror',True) and (b['x'] or b['z']) else [1]):
      x,z=sign*b['x'],sign*b['z'];w,d,h=b['w'],b['d'],b['h']
      for a,width,fx,fz in ((0,w,x,z+d/2),(math.pi,w,x,z-d/2),(math.pi/2,d,x+w/2,z),(-math.pi/2,d,x-w/2,z)):
        rows=max(1,round(h/.46));cols=max(1,round(width/.82))
        for row in range(rows):
          # Horizontal beds and alternate joints read as masonry, not panels.
          y=(row+.5)*h/rows
          for col in range(cols):
            u=(col+.5)*width/cols-width/2
            box('Courtyard dressed ashlar',fx+math.cos(a)*u+math.sin(a)*.007,y,fz-math.sin(a)*u+math.cos(a)*.007,
                width/cols-.024,h/rows-.025,.014,stone if (row+col)%4 else trim,a)
# Save editable source, then bake bevels and batch by material for runtime.
bpy.ops.wm.save_as_mainfile(filepath=str(ROOT/'art/fortress-kit/fortress-kit.blend'))
bpy.ops.object.select_all(action='SELECT');bpy.ops.object.convert(target='MESH')
groups={}
for o in list(bpy.context.scene.objects):
    if o.type=='MESH':groups.setdefault(o.data.materials[0].name,[]).append(o)
for name,objects in groups.items():
    bpy.ops.object.select_all(action='DESELECT')
    for o in objects:o.select_set(True)
    bpy.context.view_layer.objects.active=objects[0];bpy.ops.object.join();bpy.context.object.name=name
bpy.ops.export_scene.gltf(filepath=str(ROOT/'public/assets/calle/fortress-kit.glb'),export_format='GLB',export_yup=True)
