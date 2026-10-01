# The phone (tall) version of the landing photo, 1 Oct 2026: landing-portrait.py extends
# the sky upward and the grass downward into portrait-full.png; landing-animate-portrait.py
# renders client/public/niko-landing-{tall,box-tall}.webp and niko-landing-loop-tall.mp4
# from it. Run both from one working folder; needs numpy, opencv, pillow, imageio-ffmpeg.
import numpy as np, cv2
SRC='C:/Users/User/Documents/Claude/Projects/EGGSY/client/public/niko-landing.webp'
im=cv2.imread(SRC).astype(np.float32)   # 2048x2048
H=W=2048
T,B=900,700                              # extra sky above, grass below
rng=np.random.default_rng(3)

# ---- sky: continue the top rows' colour upward, a little deeper, with soft clouds
top=cv2.GaussianBlur(cv2.GaussianBlur(im[0:40].mean(axis=0,keepdims=True),(0,0),sigmaX=400),(0,0),sigmaX=400)  # 1xW, broad
deep=top*np.array([1.0,0.93,0.86],np.float32)        # BGR: bluer/deeper higher up
t=np.linspace(1,0,T,dtype=np.float32)[:,None,None]   # 1 at very top
sky=top*(1-t)+deep*t
sky=np.repeat(sky,1,axis=0) if sky.shape[0]==T else sky
# clouds: anisotropic fBm, soft
def fbm(h,w):
    acc=np.zeros((h,w),np.float32); amp=1.0
    for k,s in enumerate([220,110,55,28]):
        n=rng.standard_normal((h//s+3,w//s+3)).astype(np.float32)
        n=cv2.resize(n,(w+3*s,h+3*s),interpolation=cv2.INTER_CUBIC)[:h,:w]
        acc+=amp*n; amp*=0.5
    return acc
n=fbm(T,W); n=cv2.resize(cv2.resize(n,(W,T//2)),(W,T))  # flatten vertically
n=(n-n.mean())/n.std()
cov=np.clip((n-0.55)/1.3,0,1)**1.4
cov*=np.clip(np.linspace(0.25,1.0,T),0,1)[:,None]      # fewer near the seam
cov=cv2.GaussianBlur(cov,(0,0),6)
cloud=np.array([236,236,240],np.float32)
shade=np.array([200,196,196],np.float32)
lit=1-np.clip(np.gradient(cov,axis=0)*-40,0,1)[...,None]
ccol=cloud*lit+shade*(1-lit)
sky=sky*(1-cov[...,None]*0.9)+ccol*cov[...,None]*0.9
# seam: blend into the photo over 120 px
out=np.zeros((T+H+B,W,3),np.float32)
out[:T]=sky; out[T:T+H]=im
S=260
a=np.linspace(0,1,S,dtype=np.float32)[:,None,None]
out[T:T+S]=sky[-1:]*(1-a)+im[:S]*a

# ---- grass: repeat the near band downward, each repeat a touch larger (closer)
band=im[1760:2048]                                    # 288 rows of in-focus grass
rows=[]; y=0; k=0
ext=np.zeros((B+200,W,3),np.float32)
while y<B+200:
    sc=1.0+0.18*(k+1)
    b=cv2.resize(band,(int(W*sc),int(band.shape[0]*sc)),interpolation=cv2.INTER_CUBIC)
    off=int(rng.integers(0,b.shape[1]-W))
    b=b[:,off:off+W]
    if k%2: b=b[:,::-1]
    h=b.shape[0]
    if y==0:
        ext[0:h]=b
    else:
        O=70; a2=np.linspace(0,1,O,dtype=np.float32)[:,None,None]
        ext[y-O:y]=ext[y-O:y]*(1-a2)+b[:O]*a2
        e=min(y-O+h,ext.shape[0]); ext[y:e]=b[O:O+e-y]
    y+=h-70 if y else h; k+=1
O=90; a3=np.linspace(0,1,O,dtype=np.float32)[:,None,None]
base=T+H
out[base-O:base]=im[H-O:H]*(1-a3)+ext[:O]*a3*0+im[H-O:H]*0+ (im[H-O:H]*(1-a3)+ext[:O]*a3) - im[H-O:H]*(1-a3)
out[base:base+B]=ext[O:O+B]
out=np.clip(out,0,255).astype(np.uint8)
cv2.imwrite('portrait-full.png',out)
small=cv2.resize(out,(out.shape[1]*720//out.shape[0]*1, 720)) if False else cv2.resize(out,(int(out.shape[1]*900/out.shape[0]),900),interpolation=cv2.INTER_AREA)
cv2.imwrite('portrait-preview.jpg',small)
print(out.shape)
