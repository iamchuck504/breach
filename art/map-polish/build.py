"""Small architectural kit for Fortaleza/Azoteas. Metres, game Y up.
blender -b --python art/map-polish/build.py
Editable sources are saved before material batching. No gameplay geometry.
"""
import bpy, math
from pathlib import Path
HERE=Path(__file__).resolve().parent
OUT=HERE.parents[1]/'public/assets/calle'
OUT.mkdir(parents=True,exist_ok=True)
for kind in ('fort-gate','roof-access','roof-grille','roof-cabinet'):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    def mat(name,c,metal=0,emission=0):
        m=bpy.data.materials.new(name);m.diffuse_color=(*c,1);m.use_nodes=True
        p=m.node_tree.nodes['Principled BSDF'];p.inputs['Base Color'].default_value=(*c,1)
        p.inputs['Metallic'].default_value=metal;p.inputs['Roughness'].default_value=.64
        p.inputs['Emission Color'].default_value=(*c,1);p.inputs['Emission Strength'].default_value=emission
        return m
    dark=mat('Recess and gasket',(.022,.029,.035))
    body=mat('Aged oak' if kind=='fort-gate' else 'Slate enamel',(.16,.075,.025) if kind=='fort-gate' else (.16,.23,.27),.2)
    trim=mat('Honed limestone' if kind=='fort-gate' else 'Brushed zinc',(.48,.40,.27) if kind=='fort-gate' else (.38,.45,.47),.15)
    metal=mat('Forged iron' if kind=='fort-gate' else 'Graphite steel',(.065,.074,.078),.7)
    light=mat('Warm luminaire',(.95,.62,.28),.1,2)
    def box(name,x,y,z,w,h,d,m,bevel=.006):
        bpy.ops.mesh.primitive_cube_add(size=1,location=(x,-z,y));o=bpy.context.object;o.name=name
        o.dimensions=(w,d,h);bpy.ops.object.transform_apply(location=False,rotation=False,scale=True);o.data.materials.append(m)
        if bevel:
            b=o.modifiers.new('Soft manufactured edges','BEVEL');b.width=bevel;b.segments=1
        return o
    def disc(name,x,y,z,r,m):
        bpy.ops.mesh.primitive_cylinder_add(vertices=10,radius=r,depth=.006,location=(x,-z,y),rotation=(math.pi/2,0,0))
        o=bpy.context.object;o.name=name;o.data.materials.append(m)
    if kind=='fort-gate':
        # A closed arched timber gate; never imply a traversable opening.
        for i in range(12):
            x=(i-5.5)*.125;top=1.88+math.sqrt(max(0,.77**2-x*x))
            box('Individual oak stave',x,top/2,.013,.119,top,.025,body)
        for x in (-.9,.9):
            for row in range(6):box('Dressed jamb',x,.16+row*.30,.020,.27,.287,.04,trim)
        for i in range(11):
            a=i*math.pi/11+.009;b=(i+1)*math.pi/11-.009
            outline=[(.77*math.cos(a),1.82+.77*math.sin(a)),(1.05*math.cos(a),1.82+1.05*math.sin(a)),(1.05*math.cos(b),1.82+1.05*math.sin(b)),(.77*math.cos(b),1.82+.77*math.sin(b))]
            verts=[(x,-z,y) for z in (0,.044) for x,y in outline]
            mesh=bpy.data.meshes.new('Radial cut stone');mesh.from_pydata(verts,[],[(0,3,2,1),(4,5,6,7),(0,1,5,4),(1,2,6,5),(2,3,7,6),(3,0,4,7)]);mesh.update()
            o=bpy.data.objects.new('Arch voussoir',mesh);bpy.context.scene.collection.objects.link(o);mesh.materials.append(trim)
        for x in (-.4,.4):
            for y in (.46,1.35):
                box('Forged hinge strap',x,y,.031,.66,.065,.015,metal,.002)
                for dx in (-.26,.26):disc('Hinge rivet',x+dx,y,.043,.018,trim)
            disc('Lock escutcheon',x*.3,1.0,.04,.075,metal)
            box('Door pull',x*.3,1.0,.051,.028,.15,.026,metal)
    elif kind=='roof-access':
        box('Dark steel frame',0,1.16,.015,1.42,2.32,.03,dark)
        box('Insulated access door',0,1.16,.025,1.22,2.15,.026,body)
        for x in (-.68,.68):box('Folded metal jamb',x,1.17,.029,.08,2.34,.025,trim)
        box('Lintel',0,2.34,.031,1.44,.08,.03,trim)
        box('Kick plate',0,.20,.043,1.13,.26,.012,metal)
        box('Recessed wired glass',0,1.73,.043,.57,.37,.012,dark)
        for x in (-.17,0,.17):box('Window wire',x,1.73,.051,.008,.35,.004,trim,0)
        box('Lever handle',.43,1.0,.058,.16,.025,.023,trim)
        box('Overdoor fixture',0,2.46,.021,.92,.10,.04,metal)
        box('Diffuser',0,2.445,.046,.79,.045,.01,light)
    elif kind=='roof-grille':
        box('Vent surround',0,.35,.010,1,.70,.02,trim)
        box('Recessed airflow cavity',0,.35,.022,.91,.60,.013,dark)
        for row in range(7):
            box('Folded louvre',0,.105+row*.08,.033,.84,.031,.023,body,.004)
        for x in (-.455,.455):
            for y in (.055,.645):disc('Captive screw',x,y,.023,.012,metal)
    else:
        box('Sealed electrical cabinet',0,.70,.015,1.1,1.4,.03,body)
        for x in (-.52,.52):box('Folded cabinet edge',x,.70,.032,.035,1.36,.025,trim)
        box('Door seam',0,.69,.033,.008,1.30,.004,dark,0)
        for x in (-.10,.10):box('Quarter turn latch',x,.75,.040,.035,.10,.016,metal)
        box('Meter panel',-.23,1.08,.035,.28,.25,.015,dark)
        for x in (-.29,-.17):disc('Status indicator',x,1.09,.046,.019,light)
        for x in (-.29,.29):
            for y in (.20,.26,.32):box('Cooling slot',x,y,.034,.35,.013,.008,dark,.002)
    bpy.ops.wm.save_as_mainfile(filepath=str(HERE/f'{kind}.blend'))
    # Static material batches: a few draw calls, no hundreds of loose bolts.
    bpy.ops.object.select_all(action='SELECT');bpy.ops.object.convert(target='MESH')
    groups={}
    for o in list(bpy.context.scene.objects):
        if o.type=='MESH':groups.setdefault(o.data.materials[0].name,[]).append(o)
    for name,objects in groups.items():
        bpy.ops.object.select_all(action='DESELECT')
        for o in objects:o.select_set(True)
        bpy.context.view_layer.objects.active=objects[0];bpy.ops.object.join();bpy.context.object.name=f'{kind}-{name}'
    bpy.ops.export_scene.gltf(filepath=str(OUT/f'{kind}.glb'),export_format='GLB',export_yup=True)
