import numpy as np, cv2, subprocess, sys, math
import imageio_ffmpeg
SRC='C:/Users/User/Documents/Claude/Projects/EGGSY/client/public/niko-landing.webp'
N=1536; S=N/1024
FPS=24; L=12.0; NF=int(FPS*L)
full=cv2.imread(SRC, cv2.IMREAD_COLOR)            # 2048 BGR
base=cv2.resize(full,(N,N),interpolation=cv2.INTER_AREA).astype(np.float32)
Y,X=np.mgrid[0:N,0:N].astype(np.float32)
y1024=Y/S; x1024=X/S
POLY=[(121,366),(330,352),(598,338),(690,327),(800,334),(918,352),(921,760),(690,790),(121,752)]
box=np.zeros((N,N),np.uint8)
cv2.fillPoly(box,[np.array([(x*S,y*S) for x,y in POLY],np.int32)],255)
box=cv2.dilate(box,np.ones((9,9),np.uint8))
free=1-cv2.GaussianBlur(box.astype(np.float32)/255,(0,0),4)
def smooth(a,b,v):
    t=np.clip((v-a)/(b-a),0,1); return t*t*(3-2*t)
sky=(1-smooth(240,320,y1024))*free
grass=(smooth(500,1024,y1024)**1.4)*free
rng=np.random.default_rng(7)
noise=cv2.GaussianBlur(rng.standard_normal((N,N)).astype(np.float32),(0,0),40)
noise=noise/np.abs(noise).max()*2.2
A=3.2*S; D=70*S
ff=imageio_ffmpeg.get_ffmpeg_exe()
out=sys.argv[1]; crf=sys.argv[2]
p=subprocess.Popen([ff,'-y','-loglevel','error','-f','rawvideo','-pix_fmt','bgr24','-s',f'{N}x{N}','-r',str(FPS),'-i','-',
  '-c:v','libx264','-preset','slow','-crf',crf,'-profile:v','high','-pix_fmt','yuv420p','-movflags','+faststart','-an',out],stdin=subprocess.PIPE)
def shift(dx):
    return cv2.remap(base,X-dx,Y,cv2.INTER_LINEAR,borderMode=cv2.BORDER_REFLECT)
for i in range(NF):
    t=i/FPS
    ph=2*math.pi*(4*t/L) - 2*math.pi*x1024/260 - 2*math.pi*y1024/900 + noise
    gust=0.6+0.4*np.sin(2*math.pi*t/L - 2*math.pi*x1024/700)
    dx=A*grass*gust*np.sin(ph); dy=0.3*A*grass*gust*np.cos(ph)
    frame=cv2.remap(base,X-dx,Y-dy,cv2.INTER_LINEAR,borderMode=cv2.BORDER_REFLECT)
    a=t/L
    sk=(1-a)*shift(D*t/L)+a*shift(D*(t/L-1))
    m=sky[...,None]
    frame=frame*(1-m)+sk*m
    p.stdin.write(np.clip(frame,0,255).astype(np.uint8).tobytes())
p.stdin.close(); p.wait()
# sharp box overlay, full size with alpha
M=2048; s2=M/1024
mask=np.zeros((M,M),np.uint8)
cv2.fillPoly(mask,[np.array([(x*s2,y*s2) for x,y in POLY],np.int32)],255)
mask=cv2.GaussianBlur(mask,(0,0),1.2)
rgba=cv2.cvtColor(full,cv2.COLOR_BGR2BGRA); rgba[...,3]=mask
cv2.imwrite('box-overlay.png',rgba)
print('done')
