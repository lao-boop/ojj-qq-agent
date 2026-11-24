"""Rasterize a Windows metafile using the Windows GDI+ image decoder."""
import ctypes as ct
from uuid import UUID


class StartupInput(ct.Structure):
    _fields_ = [('version', ct.c_uint32), ('callback', ct.c_void_p),
                ('background', ct.c_int), ('codecs', ct.c_int)]


def render(source, destination):
    api = ct.WinDLL('gdiplus')
    token, image, bitmap, graphics = (ct.c_void_p() for _ in range(4))

    def check(status):
        if status:
            raise OSError('GDI+ status %d' % status)

    check(api.GdiplusStartup(ct.byref(token),ct.byref(StartupInput(1,None,0,0)),None))
    try:
        check(api.GdipLoadImageFromFile(ct.c_wchar_p(source),ct.byref(image)))
        w,h = ct.c_uint(),ct.c_uint()
        check(api.GdipGetImageWidth(image,ct.byref(w)))
        check(api.GdipGetImageHeight(image,ct.byref(h)))
        scale = min(3,2000/max(1,w.value,h.value))
        width,height = max(1,round(w.value*scale)),max(1,round(h.value*scale))
        check(api.GdipCreateBitmapFromScan0(width,height,0,0x26200a,None,ct.byref(bitmap)))
        check(api.GdipGetImageGraphicsContext(bitmap,ct.byref(graphics)))
        check(api.GdipGraphicsClear(graphics,ct.c_uint32(0xffffffff)))
        check(api.GdipDrawImageRectI(graphics,image,0,0,width,height))
        png = ct.create_string_buffer(UUID('557cf406-1a04-11d3-9a73-0000f81ef32e').bytes_le)
        check(api.GdipSaveImageToFile(bitmap,ct.c_wchar_p(destination),png,None))
    finally:
        if graphics: api.GdipDeleteGraphics(graphics)
        if bitmap: api.GdipDisposeImage(bitmap)
        if image: api.GdipDisposeImage(image)
        api.GdiplusShutdown(token)
