"""Refine existing offline decoration, preserving world transforms and UVs.
Uses the same GLB pipeline as urban-assets.js. No gameplay metadata is edited.
"""
import bpy,math
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2];HERE=ROOT/'art/map-refresh'
def material(name,c,metal=0,rough=.65):
 m=bpy.data.materials.new(name);m.diffuse_color=(*c,1);m.use_nodes=True
 p=m.node_tree.nodes.get('Principled BSDF');p.inputs['Base Color'].default_value=(*c,1);p.inputs['Metallic'].default_value=metal;p.inputs['Roughness'].default_value=rough
 return m
def box(name,x,y,z,w,h,d,m,ry=0):
 verts=[(sx*w/2,sz*d/2,sy*h/2) for sx,sz,sy in [(-1,-1,-1),(1,-1,-1),(1,1,-1),(-1,1,-1),(-1,-1,1),(1,-1,1),(1,1,1),(-1,1,1)]]
 mesh=bpy.data.meshes.new(name);mesh.from_pydata(verts,[],[(0,3,2,1),(4,5,6,7),(0,1,5,4),(1,2,6,5),(2,3,7,6),(3,0,4,7)]);mesh.materials.append(m)
 o=bpy.data.objects.new(name,mesh);bpy.context.collection.objects.link(o);o.location=(x,-z,y);o.rotation_euler.z=-ry
 return o
def cylinder(name,x,y,z,r,h,m):
 bpy.ops.mesh.primitive_cylinder_add(vertices=20,radius=r,depth=h,location=(x,-z,y));o=bpy.context.object;o.name=name;o.data.materials.append(m);return o
def save(name):
 # Keep editable, unbatched sources. Pack imported texture images into .blend.
 bpy.ops.file.pack_all();bpy.ops.wm.save_as_mainfile(filepath=str(HERE/f'{name}.blend'))
 # Merge by complete material signature; preserve transparent/double-sided.
 groups={}
 for o in list(bpy.context.scene.objects):
  if o.type=='MESH':groups.setdefault(tuple(m.name for m in o.data.materials),[]).append(o)
 for i,objects in enumerate(groups.values()):
  bpy.ops.object.select_all(action='DESELECT')
  for o in objects:o.select_set(True)
  bpy.context.view_layer.objects.active=objects[0];bpy.ops.object.convert(target='MESH');bpy.ops.object.join();bpy.context.object.name=f'{name}-material-{i}'
 bpy.ops.export_scene.gltf(filepath=str(ROOT/f'public/assets/calle/{name}.glb'),export_format='GLB',export_yup=True)
for kind in ('metro','prision','pueblo'):
 bpy.ops.wm.read_factory_settings(use_empty=True)
 bpy.ops.import_scene.gltf(filepath=str(HERE/f'input/{kind}.glb'))
 # Existing UVs and material images are retained. Bevels only on sizeable
 # closed hard-surface pieces, not rails, thin signs, panes or rubble.
 for o in list(bpy.context.scene.objects):
  if o.type!='MESH':continue
  dims=sorted(o.dimensions)
  if len(o.data.polygons)==12 and dims[0]>.11 and dims[2]<8:
   bevel=o.modifiers.new('Readable softened construction edge','BEVEL');bevel.width=min(.025,dims[0]*.06);bevel.segments=1
   bevel.affect='EDGES'
 metal=material('Graphite hardware',(.06,.09,.105),.7,.43)
 glass=material('Dark sealed glazing',(.008,.017,.022),.12,.24)
 frame=material('Zinc trim',(.28,.34,.36),.62,.46)
 wood=material('Weathered timber',(.22,.13,.075),0,.9)
 if kind=='metro':
  for x,z,d in ((-2.2,-11.5,7),(2.2,11.5,7),(2.6,-3.2,6),(-2.6,3.2,6)):
   for s in (-1,1):
    zz=z+s*(d/2+.046)
    box('Train end window gasket',x,2.12,zz,1.76,.77,.012,metal)
    box('Train end dark glazing',x,2.12,zz+s*.01,1.62,.64,.012,glass)
    box('Centre glazing mullion',x,2.12,zz+s*.021,.04,.65,.009,frame)
    box('Windscreen wiper',x-.27,1.87,zz+s*.025,.49,.025,.013,metal)
    box('End maintenance panel',x,.75,zz,1.38,.62,.012,frame)
    for xx in (-.49,.49):box('Panel latch',x+xx,.75,zz+s*.013,.035,.10,.014,metal)
  for x,z,rot in ((-11,-17.5,0),(11,17.5,math.pi),(11.5,-13,math.pi/2),(-11.5,13,-math.pi/2)):
   # Ticket console controls, attached to the original low housing.
   for u in (-.48,.48):
    xx=x+math.cos(rot)*u-math.sin(rot)*.39;zz=z-math.sin(rot)*u-math.cos(rot)*.39
    box('Ticket slot',xx,.37,zz,.18,.045,.014,metal,rot)
 if kind=='prision':
  for s in (-1,1):
   x,z=s*17,s*24
   for a in (0,math.pi/2,math.pi,math.pi*1.5):
    nx,nz=math.sin(a),math.cos(a)
    box('Observation cabin glazing frame',x+nx*1.205,3.86,z+nz*1.205,1.70,.62,.015,metal,a)
    box('Observation cabin dark window',x+nx*1.215,3.86,z+nz*1.215,1.56,.49,.01,glass,a)
    box('Security window mullion',x+nx*1.225,3.86,z+nz*1.225,.055,.50,.01,frame,a)
  for x,z in ((-12.98,-17),(-12.98,-8),(12.98,17),(12.98,8)):
   side=-1 if x<0 else 1
   box('Cell lock housing',x-side*.025,1.1,z,.06,.26,.20,metal)
 if kind=='pueblo':
  for x,y,z,a,width,n in ((-12,1.6,-18.485,math.pi,5.75,2),(12,1.6,18.485,0,5.75,2),(-13.985,1.6,-16,math.pi/2,4.75,1),(13.985,1.6,16,-math.pi/2,4.75,1),(9.485,1.03,-14,-math.pi/2,5.65,2),(-9.485,1.03,14,math.pi/2,5.65,2)):
   for i in range(n):
    u=(i-(n-1)/2)*min(1.35,width/(n+.5))
    # Ruin planes used a longitudinal local offset for east/west faces.
    xx=x+(0 if abs(math.sin(a))>.5 else u);zz=z+(u if abs(math.sin(a))>.5 else 0)
    for yy in (y+.02,y+.38):box('Boarded ruin opening',xx+math.sin(a)*.032,yy,zz+math.cos(a)*.032,.74,.13,.024,wood,a)
 save(f'refined-{kind}')
# A reusable rooftop tank in its original 2.2 m diameter / 2.12 m envelope.
bpy.ops.wm.read_factory_settings(use_empty=True)
steel=material('Weathered painted steel',(.21,.28,.31),.52,.6);iron=material('Band steel',(.065,.085,.09),.65,.44);lid=material('Dull zinc',(.37,.42,.41),.7,.55)
cylinder('Water reservoir',0,.75,0,1,1.5,steel)
for y in (.11,.72,1.39):cylinder('Rolled reinforcing band',0,y,0,1.018,.055,iron)
bpy.ops.mesh.primitive_cone_add(vertices=20,radius1=1.1,radius2=.16,depth=.55,location=(0,0,1.75));bpy.context.object.name='Conical reservoir cap';bpy.context.object.data.materials.append(lid)
cylinder('Inspection hatch',0,2.04,0,.17,.06,iron)
for x in (-.64,.64):box('Support shoe',x,.045,0,.24,.09,1.30,iron)
save('refined-roof-tank')
