# The phone (tall) version of the landing photo, 1 Oct 2026: landing-portrait.py extends
# the sky upward (the photo's own sky band, flipped and moved) and quilts sharp grass downward into portrait-full.png; landing-animate-portrait.py
# renders client/public/niko-landing-{tall,box-tall}.webp and niko-landing-loop-tall.mp4
# from it. Run both from one working folder; needs numpy, opencv, pillow, imageio-ffmpeg.
import numpy as np, cv2
SRC='C:/Users/User/Documents/Claude/Projects/EGGSY/client/public/niko-landing.webp'
im=cv2.imread(SRC).astype(np.float32); H=W=2048
T,B=900,700
KEEP=1830                     # the photo below this is out of focus; stitched grass takes over
B=B+(H-KEEP)
rng=np.random.default_rng(11)

def hshift(img,dx):
    """Roll sideways, hiding the wrap with a crossfade of the two edges."""
    out=np.roll(img,dx,axis=1); F=260
    x0=dx%W
    a=np.linspace(0,1,F,dtype=np.float32)[None,:,None]
    lo=max(0,x0-F//2); hi=min(W,lo+F)
    l=img[:, (lo-x0)%W:(lo-x0)%W+(hi-lo)] if False else None
    # blend across the seam with a mirrored strip, soft sky makes this invisible
    strip=cv2.GaussianBlur(out[:,max(0,x0-F):min(W,x0+F)],(0,0),sigmaX=60,sigmaY=1)
    out[:,max(0,x0-F):min(W,x0+F)]=strip
    return out

# ---- sky: the photo's own sky band, flipped and moved, stacked upward
band=im[0:560].copy()
pieces=[hshift(band[:,::-1],700), hshift(band,-500), hshift(band[:,::-1],-200)]
sky=np.zeros((T+400,W,3),np.float32); y=T+400; O=220
first=True
for p in pieces:
    h=p.shape[0]; top=y-h
    if first:
        sky[max(0,top):y]=p[max(0,-top):]; first=False
    else:
        a=np.linspace(1,0,O,dtype=np.float32)[:,None,None]   # 1 = new piece at its top part
        seg_top=max(0,top)
        part=p[max(0,-top):]
        ov_start=y-O
        sky[ov_start:y]=sky[ov_start:y]*(1-a)+part[-O:]*a  if False else sky[ov_start:y]*(np.linspace(0,1,O,dtype=np.float32)[:,None,None])+part[-O:]*(1-np.linspace(0,1,O,dtype=np.float32)[:,None,None])
        sky[seg_top:ov_start]=part[:ov_start-seg_top]
    y=top+O
sky=sky[-(T+O):]                    # the last O rows overlap the photo's top
# a sky deepens with height
g=np.linspace(0,1,sky.shape[0],dtype=np.float32)[::-1][:,None,None]   # 1 at top
sky=sky*(1-0.12*g)+np.array([60,20,0],np.float32)*0.12*g*0
sky=sky*np.array([1.0,1-0.06*1,1-0.12*1],np.float32)**0 * 1
sky[:, :, 1]*=1-0.06*g[:,:,0]; sky[:, :, 2]*=1-0.13*g[:,:,0]

# ---- grass: quilt random patches of the in-focus grass, minimum-error seams
SY0,SY1=1650,1830                                   # the sharp grass under the box
src=im[SY0:SY1]
P,OV=120,34
def best_cut(e):                                     # e: overlap error h x w, cut down columns
    h,w=e.shape; c=e.copy()
    for i in range(1,h):
        l=np.r_[np.inf,c[i-1,:-1]]; r=np.r_[c[i-1,1:],np.inf]
        c[i]+=np.minimum(np.minimum(l,c[i-1]),r)
    path=np.zeros(h,int); path[-1]=np.argmin(c[-1])
    for i in range(h-2,-1,-1):
        j=path[i+1]; lo=max(0,j-1); hi=min(w,j+2)
        path[i]=lo+np.argmin(c[i,lo:hi])
    m=np.zeros((h,w),np.float32)
    for i in range(h): m[i,path[i]:]=1
    return m
GH=B+P; q=np.zeros((GH,W+P,3),np.float32); filled=np.zeros((GH,W+P),bool)
for yy in range(0,GH-OV,P-OV):
    for xx in range(0,W+P-OV,P-OV):
        best=None
        for _ in range(24):
            sy=rng.integers(0,src.shape[0]-P); sx=rng.integers(0,W-P)
            # keep clear of the two pebbles
            if sx+P>1360 and sx<1620 and SY0+sy<1750 and SY0+sy+P>1640: continue
            cand=src[sy:sy+P,sx:sx+P]
            hh=min(P,GH-yy); ww=min(P,W+P-xx); cand=cand[:hh,:ww]
            err=0
            if xx>0: err+=((cand[:,:OV]-q[yy:yy+hh,xx:xx+OV])**2).sum()
            if yy>0: err+=((cand[:OV]-q[yy:yy+OV,xx:xx+ww])**2).sum()
            if best is None or err<best[0]: best=(err,cand)
        if best is None: continue
        cand=best[1]; hh,ww=cand.shape[:2]
        mask=np.ones((hh,ww),np.float32)
        if xx>0:
            e=((cand[:,:OV]-q[yy:yy+hh,xx:xx+OV])**2).sum(2); mask[:,:OV]*=best_cut(e)
        if yy>0:
            e=((cand[:OV]-q[yy:yy+OV,xx:xx+ww])**2).sum(2).T; mask[:OV,:]*=best_cut(e).T
        mask=cv2.GaussianBlur(mask,(0,0),1.2)[...,None]
        region=q[yy:yy+hh,xx:xx+ww]
        q[yy:yy+hh,xx:xx+ww]=region*(1-mask)+cand*mask
q=q[:B+OV*2,:W]
# closer rows are a little larger: zoom grows toward the bottom
Hq=q.shape[0]; ys=np.arange(Hq,dtype=np.float32)
z=np.ones_like(ys)
ysrc=np.cumsum(1/z); ysrc-=ysrc[0]
cx=W/2
mx=(np.arange(W,dtype=np.float32)[None,:]-cx)/z[:,None]+cx
my=np.repeat(ysrc[:,None],W,axis=1).astype(np.float32)
grass=cv2.remap(q,mx.astype(np.float32),my,cv2.INTER_CUBIC,borderMode=cv2.BORDER_REFLECT)

out=np.zeros((T+KEEP+B,W,3),np.float32)
out[:T]=sky[:T]; out[T:T+KEEP]=im[:KEEP]
a=np.linspace(0,1,O,dtype=np.float32)[:,None,None]
out[T:T+O]=sky[T:T+O]*(1-a)+im[:O]*a
OG=60; a=np.linspace(0,1,OG,dtype=np.float32)[:,None,None]
out[T+KEEP-OG:T+KEEP]=im[KEEP-OG:KEEP]*(1-a)+grass[:OG]*a
out[T+KEEP:]=grass[OG:OG+B]
out=np.clip(out,0,255).astype(np.uint8)
cv2.imwrite('portrait-full.png',out)
cv2.imwrite('portrait-preview.jpg',cv2.resize(out,(505,900),interpolation=cv2.INTER_AREA))
cv2.imwrite('portrait-top.jpg',cv2.resize(out[:1500],(800,586),interpolation=cv2.INTER_AREA))
cv2.imwrite('portrait-bottom.jpg',cv2.resize(out[-1300:],(800,508),interpolation=cv2.INTER_AREA))
print(out.shape)
