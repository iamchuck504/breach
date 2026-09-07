"""Derive the district from the approved editable Blender cafe. Background only."""
import bpy, math, json
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3]
SOURCE=Path(__file__).with_name('source.blend')
# name, style, frontage, height, enamel, subtitle
SHOPS=[
 ('NORTHLINE RX','pharmacy',11.7,9.25,(.055,.17,.15),'PRESCRIPTIONS / DAILY CARE'),
 ('DAILY BREAD','bakery',11.7,9.25,(.29,.095,.055),'BREAD / PASTRIES / COFFEE'),
 ('CEDAR PHARMACY','pharmacy',7.6,9.25,(.095,.19,.16),'YOUR NEIGHBORHOOD PHARMACY'),
 ('OVEN No. 8','bakery',7.6,9.25,(.30,.12,.065),'SMALL BATCH / BAKED EARLY'),
 ('MOTOR WORKS','garage',7.6,7.3,(.10,.14,.17),'SERVICE / REPAIR / ALIGNMENT'),
 ('SIGNAL ELECTRONICS','electronics',7.6,7.3,(.035,.115,.20),'RADIO / AUDIO / REPAIRS'),
 ('IRON & KEY','hardware',15.7,7.3,(.17,.19,.14),'TOOLS / LOCKS / HARDWARE'),
 ('UNION BARBER','barber',15.7,7.3,(.22,.055,.045),'CUTS / SHAVES / SINCE 1978'),
 ('SPIN CYCLE','laundry',7.6,7.3,(.045,.17,.22),'SELF SERVICE / WASH & FOLD'),
 ('PAPER & INK','stationery',7.6,7.3,(.16,.19,.10),'PRINT / PAPER / STATIONERY'),
 ('NEIGHBOR MARKET','market',7.6,9.35,(.23,.085,.06),'GROCERIES / FRESH PRODUCE'),
 ('SOUTH END DELI','deli',11.7,9.35,(.11,.18,.10),'SANDWICHES / GROCERIES'),
 ('NIGHT OWL CAFE','cafe',11.7,9.35,(.075,.09,.16),'LATE COFFEE / EARLY BREAKFAST'),
]
def slug(name):return name.lower().replace(' & ','-').replace(' ','-').replace('.','')
manifest={}
for name,style,span,height,color,tag in SHOPS:
    bpy.ops.wm.open_mainfile(filepath=str(SOURCE))
    scene=bpy.data.scenes['Breach_Corner_Coffee_Study'];bpy.context.window.scene=scene
    asset=[o for o in scene.objects if o.type in {'MESH','FONT'} and o.name!='Presentation pavement']
    def material(n,c,metal=0):
        m=bpy.data.materials.new(n);m.diffuse_color=(*c,1);m.use_nodes=True
        p=m.node_tree.nodes.get('Principled BSDF');p.inputs['Base Color'].default_value=(*c,1)
        p.inputs['Roughness'].default_value=.65;p.inputs['Metallic'].default_value=metal
        return m
    enamel=bpy.data.materials['Coffee enamel'];enamel.diffuse_color=(*color,1)
    enamel.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value=(*color,1)
    ivory=bpy.data.materials['Ivory lettering'];black=bpy.data.materials['Charcoal painted metal']
    metal=bpy.data.materials['Aged brass'];glass=bpy.data.materials['Opaque dark glazing']
    warm=material('Warm products',(.55,.31,.11));red=material('Label red',(.40,.07,.045))
    pale=material('Appliance enamel',(.56,.61,.59),.25)
    blue=material('Screen blue',(.035,.22,.29),.3)
    # Slight masonry variation, same scale and chunky construction vocabulary.
    tint={'electronics':(.70,.84,.94),'garage':(.7,.78,.80),'barber':(.89,.77,.74),
          'laundry':(.87,.93,.91),'stationery':(.95,.96,.83)}.get(style,(1,1,1))
    for m in bpy.data.materials:
        if m.name.startswith('Brick tone'):
            p=m.node_tree.nodes['Principled BSDF'];c=p.inputs['Base Color'].default_value
            p.inputs['Base Color'].default_value=(*(c[i]*tint[i] for i in range(3)),1)
    removed=[];ratio=span/7.6;short=height<8
    for o in asset:
        n=o.name;x,y,z=o.location
        # Delete only objects in this freshly loaded, disposable background study.
        if short and ((n.startswith(('Window','Sloped sill','Lintel','Pipe clamp')) and z>6.5)
                      or (n.startswith('Brick course') and z>6.93)):
            removed.append(o);continue
        # Move complete window bays, never stretch the spacing of their parts.
        if n.startswith(('Window','Sloped sill','Lintel')):
            bay=min((-2.45,0,2.45),key=lambda center:abs(x-center))
            o.location.x=bay*ratio+(x-bay)
        else:o.location.x*=ratio
        if n.startswith(('Brick course','Existing envelope','Roof','Stepped cornice','Floor string','Store surround','Sign ')):
            o.scale.x*=ratio
        if n=='Existing envelope':o.scale=(ratio,1,(height-.18)/9.17);o.location.z=(height-.18)/2
        if n.startswith(('Roof','Stepped cornice')):o.location.z-=9.35-height
        if n.startswith('Drainpipe'):
            o.dimensions.z=height-3.45;o.location.z=(3.0+height-.45)/2
        # Preserve door width/height and move its center to the original access bay.
        if n.startswith('Door') or n=='OPEN':o.location.x += span*.31-2.21*ratio
        # Wide shops gain a wider display, never giant doors or giant windows.
        if n.startswith(('Display','Shop sill','Sloping','Canopy valance')):o.scale.x*=ratio
        if n.startswith('Window') or n.startswith(('Sloped sill','Lintel')):
            pass # only bay spacing scales; individual window size remains human.
        if o.type=='FONT':
            o.data.resolution_u=2
            if n=='CORNER COFFEE':
                o.data.body=name;o.name='Shop title';o.data.size=min(.40,span*.70/max(1,len(name))/.62)
                font=Path('C:/Windows/Fonts')/('georgiab.ttf' if style in ('bakery','cafe','deli') else 'bahnschrift.ttf')
                if font.exists():o.data.font=bpy.data.fonts.load(str(font))
            elif n.startswith('ROASTED DAILY'):o.data.body=tag;o.name='Shop subtitle'
            elif n.startswith('COFFEE'):
                o.data.body={'bakery':'FRESH FROM THE OVEN','laundry':'WASH / DRY / FOLD',
                    'market':'FRESH EVERY DAY','deli':'MADE TO ORDER','cafe':'COFFEE AFTER DARK'}.get(style,tag)
                o.data.size=.12
        # Hard-edged technical signs versus softer hospitality plaques.
        if n.startswith('Sign'):
            sign_width=min(span*.78,max(5.4,len(name)*.24+1.3))
            o.scale.x=(sign_width if n=='Sign brass frame' else sign_width-.20)/(5.91 if n=='Sign brass frame' else 5.71)
            for mod in o.modifiers:
                if mod.type=='BEVEL':mod.width=.012 if style in ('garage','electronics','hardware') else .05
        if style in ('garage','electronics','hardware','barber','stationery') and n.startswith(('Sloping','Canopy','COFFEE')):
            removed.append(o)
    for o in removed:asset.remove(o);bpy.data.objects.remove(o,do_unlink=True)
    def box(n,x,y,z,w,d,h,m,bev=.01):
        bpy.ops.mesh.primitive_cube_add(size=1,location=(x,y,z));o=bpy.context.object;o.name=n;o.dimensions=(w,d,h)
        bpy.ops.object.transform_apply(location=False,rotation=False,scale=True);o.data.materials.append(m)
        if bev:
            b=o.modifiers.new('Edge softness','BEVEL');b.width=bev;b.segments=2
        asset.append(o);return o
    def text(body,x,y,z,size,m):
        c=bpy.data.curves.new(body,'FONT');c.body=body;c.align_x='CENTER';c.size=size;c.extrude=.002;c.resolution_u=2
        o=bpy.data.objects.new(body,c);scene.collection.objects.link(o);o.location=(x,y,z);o.rotation_euler=(math.pi/2,0,0)
        c.materials.append(m);asset.append(o)
    def ring(n,x,y,z,r,m):
        bpy.ops.mesh.primitive_torus_add(major_segments=16,minor_segments=6,location=(x,y,z),
            rotation=(math.pi/2,0,0),major_radius=r,minor_radius=.034)
        o=bpy.context.object;o.name=n;o.data.materials.append(m);asset.append(o)
    center=-1.13*ratio;left=-3.04*ratio;right=.77*ratio
    # Business-specific plaque treatment, with clear lettering margins.
    if style in ('bakery','deli','cafe'):
        box('Heritage sign crown',0,-.28,3.43,sign_width*.58,.22,.10,metal,.035)
    elif style in ('electronics','garage','hardware'):
        for x in (-sign_width/2+.10,sign_width/2-.10):
            box('Industrial sign endcap',x,-.44,3.02,.085,.045,.5,pale)
    elif style=='barber':
        for x in (-sign_width/2+.18,sign_width/2-.18):
            for j in range(3):box('Barber sign chevron',x,-.445,2.84+j*.15,.13,.035,.07,ivory)
    elif style=='laundry':
        for x in (-sign_width/2+.30,sign_width/2-.30):ring('Laundry bubble',x,-.45,3.04,.16,pale)
    elif style=='stationery':
        box('Stationery underline',0,-.449,2.87,sign_width*.82,.025,.025,ivory,0)
    # Display details lie in front of opaque display back, inside the frame.
    if style in ('bakery','market','deli','pharmacy','stationery','hardware'):
        for z in (1.02,1.53):
            box('Display shelf',center,-.355,z,(right-left)*.92,.12,.055,metal)
            for j in range(max(4,round((right-left)/.42))):
                x=left+.18+j*(right-left-.36)/max(1,round((right-left)/.42)-1)
                m=warm if style=='bakery' else [pale,red,enamel][j%3]
                if style=='bakery':
                    loaf=box('Bread loaf',x,-.355,z+.13,.26,.09,.17,m,.055)
                else:box('Store goods',x,-.355,z+.14,.18,.075,.20+(j%3)*.04,m)
    elif style=='laundry':
        for j in range(3):
            x=center+(j-1)*.98
            box('Washer',x,-.35,1.08,.83,.08,.89,pale,.04)
            box('Washer controls',x,-.40,1.39,.66,.035,.10,enamel)
            ring('Washer circular door',x,-.42,1.03,.255,metal)
            box('Washer label',x+.2,-.423,1.39,.08,.025,.03,ivory)
        text('OPEN 24 HOURS',center,-.40,2.11,.19,ivory)
    elif style=='electronics':
        for j in range(3):
            x=center+(j-1)*1.02
            box('Monitor frame',x,-.35,1.46,.84,.08,.62,black)
            box('Monitor screen',x,-.405,1.46,.73,.03,.49,blue)
            box('Monitor stand',x,-.36,1.05,.30,.06,.07,pale)
        text('AUDIO   /   VIDEO   /   REPAIR',center,-.41,2.17,.16,ivory)
    elif style=='garage':
        box('Service shutter',center,-.345,1.53,(right-left),.065,1.91,black)
        for j in range(12):box('Shutter rib',center,-.40,.66+j*.145,(right-left)-.05,.045,.026,pale,0)
        for x in (left-.10,right+.10):
            box('Bay jamb',x,-.4,1.53,.16,.17,2.17,metal)
            for z in (.6,1,1.4,1.8,2.2):box('Bay caution stripe',x,-.497,z,.165,.03,.12,black,0)
        text('SERVICE BAY 01',center,-.43,2.36,.19,ivory)
    elif style=='barber':
        for x in (left+.65,right-.65):
            box('Barber chair back',x,-.36,1.30,.66,.10,.70,red,.08)
            box('Barber chair base',x,-.38,.77,.46,.10,.12,pale)
        x=right+.12
        box('Barber pole housing',x,-.46,1.85,.24,.19,.86,pale,.05)
        for j in range(5):
            stripe=box('Barber pole stripe',x,-.565,1.53+j*.15,.19,.025,.06,red,0);stripe.rotation_euler.y=-.35
        text('WALK INS WELCOME',center,-.40,2.15,.18,ivory)
    if style=='pharmacy':
        # Capsule badge, not the green crosses previously rejected.
        ring('Capsule badge',center,-.41,2.13,.16,ivory)
        text('RX',center,-.45,2.08,.15,ivory)
    if style=='hardware':
        for i in range(5):
            x=center-.8+i*.4;ring('Key head',x,-.43,2.18,.075,metal)
            box('Key blade',x,-.43,2.02,.04,.03,.2,metal)
    if style=='cafe':
        ring('Owl eye',center-.18,-.42,1.8,.13,ivory);ring('Owl eye',center+.18,-.42,1.8,.13,ivory)
        text('NIGHT SERVICE',center,-.42,1.39,.21,ivory)
    # Reuse the complete approved center window, including identical frames,
    # transoms and sills. Keep a generous masonry pier between every bay.
    if span>10:
        windows=[o for o in asset if o.name.startswith(('Window','Sloped sill','Lintel'))]
        template=[o for o in windows if abs(o.location.x)<1]
        count=4 if span<13 else 5
        spacing=(span-2.8)/(count-1)
        assert spacing>2.2
        for i in range(count):
            center=(i-(count-1)/2)*spacing
            for source in template:
                o=source.copy();o.data=source.data.copy();scene.collection.objects.link(o)
                o.location.x+=center;asset.append(o)
        for o in windows:asset.remove(o);bpy.data.objects.remove(o,do_unlink=True)
    # West-side shops keep their existing world-space door bay. Reposition parts,
    # never mirror geometry/lettering (which would reverse the signs).
    if name in {'NORTHLINE RX','CEDAR PHARMACY','MOTOR WORKS','IRON & KEY','SPIN CYCLE','NEIGHBOR MARKET','SOUTH END DELI'}:
        for o in asset:
            if o.location.z<3.6 and o.name!='Existing envelope':o.location.x *= -1
    # Convert before batching so lettering is exported and modifiers are baked.
    bpy.ops.object.select_all(action='DESELECT')
    for o in asset:o.select_set(True)
    bpy.context.view_layer.objects.active=asset[0];bpy.ops.object.convert(target='MESH')
    keep={'Existing envelope','Roof cap','Sign brass frame','Sign enamel inset','Shop title','Shop subtitle','Door leaf'}
    batches={}
    for o in list(bpy.context.selected_objects):
        if o.name not in keep:batches.setdefault(o.data.materials[0].name,[]).append(o)
    for n,items in batches.items():
        bpy.ops.object.select_all(action='DESELECT')
        for o in items:o.select_set(True)
        bpy.context.view_layer.objects.active=items[0]
        if len(items)>1:bpy.ops.object.join()
        bpy.context.object.name='District '+n
    bpy.ops.object.select_all(action='DESELECT')
    for o in scene.objects:
        if o.type=='MESH' and o.name!='Presentation pavement':o.select_set(True)
    file='district-'+slug(name)+'.glb'
    bpy.ops.export_scene.gltf(filepath=str(ROOT/'public/assets/calle'/file),use_selection=True,export_apply=True)
    manifest[name]={'file':file,'span':span,'height':height,'style':style,'meshes':len(bpy.context.selected_objects)}
(Path(__file__).with_name('district-manifest.json')).write_text(json.dumps(manifest,indent=2)+'\n')
