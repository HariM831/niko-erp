# The phone (tall) version of the landing photo, 1 Oct 2026: landing-portrait.py extends
# the sky upward and the grass downward into portrait-full.png; landing-animate-portrait.py
# renders client/public/niko-landing-{tall,box-tall}.webp and niko-landing-loop-tall.mp4
# from it. Run both from one working folder; needs numpy, opencv, pillow, imageio-ffmpeg.
import numpy as np, cv2, subprocess, math, imageio_ffmpeg
from PIL import Image
full=cv2.imread('portrait-full.png')                 # 2048 x 3648, BGR
FH,FW=full.shape[:2]; T=900
OW,OH=720,1282; s=OW/FW
FPS=24; L=12.0; NF=int(FPS*L)
base=cv2.resize(full,(OW,OH),interpolation=cv2.INTER_AREA).astype(np.float32)
Y,X=np.mgrid[0:OH,0:OW].astype(np.float32)
yf=Y/s; xf=X/s                                          # full-res coordinates
POLY=[(121,366),(330,352),(598,338),(690,327),(800,334),(918,352),(921,760),(690,790),(121,752)]
P=[(x*2, y*2+T) for x,y in POLY]                        # full-res portrait coords
box=np.zeros((OH,OW),np.uint8)
cv2.fillPoly(box,[np.array([(x*s,y*s) for x,y in P],np.int32)],255)
box=cv2.dilate(box,np.ones((5,5),np.uint8))
free=1-cv2.GaussianBlur(box.astype(np.float32)/255,(0,0),2)
def smooth(a,b,v):
    t=np.clip((v-a)/(b-a),0,1); return t*t*(3-2*t)
sky=(1-smooth(T+480,T+640,yf))*free
grass=(smooth(T+1000,FH,yf)**1.2)*free
rng=np.random.default_rng(7)
noise=cv2.GaussianBlur(rng.standard_normal((OH,OW)).astype(np.float32),(0,0),20)
noise=noise/np.abs(noise).max()*2.2
A=3.2*2*s*1.4; D=180*s*2
ff=imageio_ffmpeg.get_ffmpeg_exe()
p=subprocess.Popen([ff,'-y','-loglevel','error','-f','rawvideo','-pix_fmt','bgr24','-s',f'{OW}x{OH}','-r',str(FPS),'-i','-',
  '-c:v','libx264','-preset','slow','-crf','25','-profile:v','high','-pix_fmt','yuv420p','-movflags','+faststart','-an','niko-landing-loop-tall.mp4'],stdin=subprocess.PIPE)
def shift(dx): return cv2.remap(base,X-dx,Y,cv2.INTER_LINEAR,borderMode=cv2.BORDER_REFLECT)
for i in range(NF):
    t=i/FPS
    ph=2*math.pi*(4*t/L) - 2*math.pi*xf/520 - 2*math.pi*yf/1800 + noise
    gust=0.6+0.4*np.sin(2*math.pi*t/L - 2*math.pi*xf/1400)
    dx=A*grass*gust*np.sin(ph); dy=0.3*A*grass*gust*np.cos(ph)
    frame=cv2.remap(base,X-dx,Y-dy,cv2.INTER_LINEAR,borderMode=cv2.BORDER_REFLECT)
    a=t/L
    sk=(1-a)*shift(D*t/L)+a*shift(D*(t/L-1))
    m=sky[...,None]; frame=frame*(1-m)+sk*m
    p.stdin.write(np.clip(frame,0,255).astype(np.uint8).tobytes())
p.stdin.close(); p.wait()
# the still and the sharp box, 1440 wide
SW=1440; SH=round(FH*SW/FW)
still=cv2.resize(full,(SW,SH),interpolation=cv2.INTER_AREA)
Image.fromarray(cv2.cvtColor(still,cv2.COLOR_BGR2RGB)).save('niko-landing-tall.webp',quality=86,method=6)
m=np.zeros((SH,SW),np.uint8); k=SW/FW
cv2.fillPoly(m,[np.array([(x*k,y*k) for x,y in P],np.int32)],255)
m=cv2.GaussianBlur(m,(0,0),1.0)
rgba=cv2.cvtColor(still,cv2.COLOR_BGR2RGBA); rgba[...,3]=m
Image.fromarray(rgba).save('niko-landing-box-tall.webp',quality=90,method=6)
print('done', SW, SH)
