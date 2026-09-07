"""Refine the exported in-game props in Blender, preserving local placement.
Run: blender -b --python art/street-props/refine.py
Editable .blend files and material-batched GLBs are generated together.
"""
import bpy, math, json
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
HERE=Path(__file__).parent
manifest={}
for kind in ('coffee','hotdog','news','dumpster','jersey','roadwork','shelter'):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(HERE/'input'/f'{kind}.glb'))
    original=[o for o in bpy.context.scene.objects if o.type=='MESH']
    if kind=='news':
        for o in list(original):
            if abs(o.dimensions.x-.25)<.005 and abs(o.matrix_world.translation.z-.49)<.005:
                original.remove(o);bpy.data.objects.remove(o,do_unlink=True)
    def mat(name,color,metal=0):
        m=bpy.data.materials.new(name);m.diffuse_color=(*color,1);m.use_nodes=True
        p=m.node_tree.nodes['Principled BSDF'];p.inputs['Base Color'].default_value=(*color,1)
        p.inputs['Metallic'].default_value=metal;p.inputs['Roughness'].default_value=.55 if metal else .76
        return m
    steel=mat('Brushed stainless',(.33,.38,.39),.65)
    black=mat('Charcoal rubber',(.018,.023,.026))
    cream=mat('Warm porcelain',(.72,.65,.49))
    copper=mat('Copper trim',(.33,.15,.055),.6)
    red=mat('Terracotta enamel',(.32,.075,.045),.2)
    wood=mat('Oiled wood',(.20,.095,.045))
    # Round existing solid edges only. Thin signage and glass keep their form.
    for o in original:
        if min(o.dimensions)<.025:continue
        if len(o.data.polygons)>800:continue
        bevel=o.modifiers.new('Manufactured edge radius','BEVEL');bevel.width=.012
        bevel.segments=2;bevel.limit_method='ANGLE';bevel.angle_limit=.6
    def box(name,x,y,z,w,h,d,m,bevel=.012):
        bpy.ops.mesh.primitive_cube_add(size=1,location=(x,-z,y));o=bpy.context.object
        o.name=name;o.dimensions=(w,d,h);bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
        o.data.materials.append(m)
        if bevel:
            b=o.modifiers.new('Soft edge','BEVEL');b.width=bevel;b.segments=2
        return o
    def cyl(name,x,y,z,r,h,m,axis='y'):
        bpy.ops.mesh.primitive_cylinder_add(vertices=16,radius=r,depth=h,location=(x,-z,y))
        o=bpy.context.object;o.name=name;o.data.materials.append(m)
        if axis=='z':o.rotation_euler.x=math.pi/2
        if axis=='x':o.rotation_euler.y=math.pi/2
        b=o.modifiers.new('Machined edge','BEVEL');b.width=.006;b.segments=2
        return o
    def label(body,x,y,z,size,m,back=False):
        c=bpy.data.curves.new(body,'FONT');c.body=body;c.align_x='CENTER';c.size=size;c.extrude=.001;c.resolution_u=2
        o=bpy.data.objects.new(body,c);bpy.context.scene.collection.objects.link(o)
        o.location=(x,-z,y);o.rotation_euler=(math.pi/2,0,math.pi if back else 0);c.materials.append(m)
    if kind=='coffee':
        # Existing cart/canopy stays; refine the functional espresso station.
        box('Espresso dark control face',.27,1.30,-.129,.29,.16,.022,black)
        for x in (.19,.29,.37):cyl('Control dial',x,1.31,-.145,.025,.016,steel,'z')
        box('Espresso group head',.27,1.18,-.15,.15,.06,.08,steel)
        box('Portafilter handle',.27,1.16,-.22,.045,.035,.16,black)
        for x in (.17,.22,.27,.32,.37):box('Drip tray rib',x,1.198,-.20,.009,.008,.12,steel,.002)
        cyl('Bean grinder base',-.40,1.18,.07,.08,.16,black)
        cyl('Bean hopper',-.40,1.32,.07,.09,.13,copper)
        for i in range(3):cyl('Stacked takeaway cups',-.17,1.15+i*.07,-.06,.053,.075,cream)
        for x in (-.50,-.25,0,.25,.50):
            for y,h in ((.31,.20),(.84,.17)):
                box('Cart panel slat',x,y,-.326,.012,h,.018,copper,.002)
        box('Menu plaque',-.37,1.38,.16,.29,.37,.03,black)
        label('ESPRESSO',-.37,1.44,.138,.039,cream,True)
        label('LATTE',-.37,1.35,.138,.039,cream,True)
        for x in (-.56,.56):box('Canopy edge trim',x,2.09,0,.025,.08,.86,copper)
    elif kind=='hotdog':
        box('Griddle housing',-.40,1.16,.60,.61,.10,.34,steel)
        box('Griddle cooking surface',-.40,1.218,.60,.56,.014,.28,black,.003)
        for i in range(4):
            cyl('Griddle roller',-.60+i*.13,1.236,.60,.015,.23,steel,'z')
            cyl('Grilled sausage',-.60+i*.13,1.265,.60,.027,.16,red,'z')
        box('Serving tray',.41,1.125,.61,.35,.04,.25,steel)
        for x in (.33,.46):box('Bread roll',x,1.18,.61,.10,.07,.18,cream,.028)
        box('Small menu board',.47,1.72,-.686,.42,.59,.04,black)
        label('MENU',.47,1.91,-.66,.083,cream)
        label('HOT DOG',.47,1.76,-.66,.047,cream)
        label('SODA',.47,1.63,-.66,.047,cream)
        for x in (-.62,-.41,-.20,.01,.22,.43,.64):box('Awning stripe',x,2.247,1.02,.075,.005,.41,cream,.001)
        for x in (-.74,.74):box('Counter corner trim',x,.57,.82,.045,.77,.025,steel)
    elif kind=='news':
        for level in range(3):
            y=1.24+level*.28
            box('Magazine shelf',0,y,-.65,1.42,.035,.20,wood)
            for i in range(5):
                x=(i-2)*.27
                box('Magazine volume',x,y+.13,-.63,.21,.23,.065,[red,cream,copper][(i+level)%3])
                box('Magazine title bar',x,y+.19,-.590,.15,.025,.005,black,.001)
                box('Magazine cover picture',x,y+.095,-.589,.12,.075,.005,steel,.001)
        for i in range(4):box('Newspaper stack',-.40,1.12+i*.024,.77,.43,.018,.25,cream,.001)
        box('Till register',.43,1.19,.65,.25,.18,.24,black)
    elif kind=='dumpster':
        for x in (-.82,0,.82):
            box('Welded front rib',x,.53,-.978,.06,.65,.022,steel)
        for side in (-1,1):
            box('Lift pocket',side*1.185,.64,0,.045,.14,.65,steel)
            box('Lift pocket opening',side*1.212,.64,0,.012,.075,.52,black,.002)
        for x in (-.55,.55):
            box('Lid rubber pull',x,1.087,-.73,.23,.025,.045,black)
            for j in range(3):cyl('Lid hinge knuckle',x+(j-1)*.045,1.02,.92,.027,.043,steel,'x')
        for x in (-1.05,1.05):
            box('Safety reflector',x,.76,-.992,.10,.06,.012,cream)
    elif kind=='roadwork':
        for side in (-1,1):
            box('Barrier toe rub strip',0,.23,side*.412,2.91,.08,.012,black)
            for x in (-1.20,1.20):
                cyl('Reflector fastener',x,.74,side*.423,.035,.012,steel,'z')
            box('Construction permit plate',0,.77,side*.418,.57,.27,.016,steel)
            label('CITY WORKS',0,.81,side*.431,.066,cream,side<0)
            label('KEEP CLEAR',0,.72,side*.431,.040,cream,side<0)
    elif kind=='jersey':
        # Keep the existing concrete profile and use shallow formwork detail.
        for x in (-.7,.7):
            box('Top lifting recess',x,1.103,0,.17,.004,.065,black,.001)
    elif kind=='shelter':
        # Imported shelter geometry is retained; Blender bevels refine seats,
        # roof and posts without adding a second wall in the open front.
        for m in bpy.data.materials:
            if m.use_nodes:
                p=m.node_tree.nodes.get('Principled BSDF')
                if p:p.inputs['Roughness'].default_value=.63
    # Store a genuinely editable model before baking modifiers/material batches.
    bpy.ops.file.pack_all()
    bpy.ops.wm.save_as_mainfile(filepath=str(HERE/f'{kind}.blend'))
    bpy.ops.object.select_all(action='DESELECT')
    for o in bpy.context.scene.objects:
        if o.type in {'MESH','FONT'}:o.select_set(True)
    bpy.context.view_layer.objects.active=next(o for o in bpy.context.selected_objects)
    bpy.ops.object.convert(target='MESH')
    # Materials inherited from the game can be multi-slot. Keep those meshes;
    # merge single-slot additions to avoid a draw call per screw/product.
    batches={}
    for o in bpy.context.selected_objects:
        if len(o.data.materials)==1:batches.setdefault(o.data.materials[0].name,[]).append(o)
    for name,items in batches.items():
        bpy.ops.object.select_all(action='DESELECT')
        for o in items:o.select_set(True)
        bpy.context.view_layer.objects.active=items[0]
        if len(items)>1:bpy.ops.object.join()
        bpy.context.object.name=f'{kind} / {name}'
    bpy.ops.object.select_all(action='DESELECT')
    for o in bpy.context.scene.objects:
        if o.type=='MESH':o.select_set(True)
    path=ROOT/'public/assets/calle'/f'prop-{kind}.glb'
    bpy.ops.export_scene.gltf(filepath=str(path),use_selection=True,export_apply=True)
    manifest[kind]={'file':path.name,'meshes':len(bpy.context.selected_objects),'bytes':path.stat().st_size}
(HERE/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
