"""Generate the application's simple code-native bar icon without external dependencies."""
from pathlib import Path
import struct
import zlib

def png(size):
    rows=[]
    for y in range(size):
        row=bytearray()
        for x in range(size):
            a,b=x*512/size,y*512/size
            color=(23,45,39)
            for bx,by in [(112,247),(222,169),(332,112)]:
                if bx<=a<bx+67 and by<=b<400:
                    color=(214,239,136)
            row.extend(color)
        rows.append(b'\x00'+row)
    def chunk(kind,data):
        return struct.pack('!I',len(data))+kind+data+struct.pack('!I',zlib.crc32(kind+data)&0xffffffff)
    return b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('!2I5B',size,size,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(b''.join(rows),9))+chunk(b'IEND',b'')

if __name__=='__main__':
    root=Path(__file__).resolve().parents[1]/'public'
    for size in (192,512):
        (root/f'icon-{size}.png').write_bytes(png(size))
