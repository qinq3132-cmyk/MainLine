"""Read local attachment text with source locations; never execute document content."""
from __future__ import annotations
import io
import posixpath
import re
import zipfile
import xml.etree.ElementTree as ET

SUPPORTED = {'.docx', '.pptx', '.pdf', '.txt', '.md', '.csv', '.xlsx'}
MAX_BYTES = 20 * 1024 * 1024
MAX_TEXT = 120000
W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
A = '{http://schemas.openxmlformats.org/drawingml/2006/main}'
R = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}'
P = '{http://schemas.openxmlformats.org/presentationml/2006/main}'
S = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'


def xml(archive, name):
    content = archive.read(name)
    if len(content) > 20 * 1024 * 1024:
        raise ValueError('文件中的文字内容过大。')
    return ET.fromstring(content)


def relationships(archive, source):
    folder, filename = posixpath.split(source)
    rel = posixpath.join(folder, '_rels', filename + '.rels')
    if rel not in archive.namelist():
        return {}
    result = {}
    for item in xml(archive, rel):
        if item.attrib.get('TargetMode') == 'External':
            continue
        target = item.attrib.get('Target', '')
        path = target.lstrip('/') if target.startswith('/') else posixpath.normpath(posixpath.join(folder, target))
        result[item.attrib.get('Id')] = (path, item.attrib.get('Type', ''))
    return result


def word_text(node):
    if node.tag in {W+'del', W+'moveFrom'}:
        return ''
    if node.tag == W+'t':
        return node.text or ''
    if node.tag == W+'tab':
        return '\t'
    if node.tag in {W+'br', W+'cr'}:
        return '\n'
    return ''.join(word_text(child) for child in node)


def extract(name, content):
    suffix = '.' + name.rsplit('.', 1)[-1].lower() if '.' in name else ''
    if suffix not in SUPPORTED:
        raise ValueError('支持 Word .docx、PPT .pptx、PDF、Excel .xlsx 和文本文件。旧版 .doc / .ppt 请先另存为新格式。')
    if not content or len(content) > MAX_BYTES:
        raise ValueError('文件为空或超过 20 MB。')
    blocks, units, warning = [], 0, ''
    try:
        if suffix in {'.docx', '.pptx', '.xlsx'}:
            with zipfile.ZipFile(io.BytesIO(content)) as z:
                info = z.infolist()
                if len(info) > 10000 or sum(x.file_size for x in info) > 120*1024*1024:
                    raise ValueError('文件解压后的内容过大。')
                if suffix == '.docx':
                    if 'word/document.xml' not in z.namelist():
                        raise ValueError('不是有效的 Word 文件。')
                    parts = [('word/document.xml', '正文')]
                    parts += [(n, '附注') for n in z.namelist() if n in {'word/footnotes.xml', 'word/endnotes.xml'}]
                    parts += [(n, '页眉页脚') for n in sorted(z.namelist()) if re.fullmatch(r'word/(?:header|footer)\d+\.xml', n)]
                    for path, label in parts:
                        for i, paragraph in enumerate(xml(z, path).iter(W+'p'), 1):
                            text = word_text(paragraph).strip()
                            if text:
                                blocks.append(f'[{label} 第{i}段]\n{text}')
                                units += 1
                    kind = 'Word'
                elif suffix == '.pptx':
                    root = xml(z, 'ppt/presentation.xml')
                    rels = relationships(z, 'ppt/presentation.xml')
                    slides = [rels[x.attrib[R+'id']][0] for x in root.iter(P+'sldId') if x.attrib.get(R+'id') in rels]
                    if not slides:
                        slides = sorted((n for n in z.namelist() if re.fullmatch(r'ppt/slides/slide\d+\.xml', n)), key=lambda n:int(re.search(r'(\d+)\.xml$', n).group(1)))
                    for i, path in enumerate(slides, 1):
                        text = '\n'.join(x.text or '' for x in xml(z, path).iter(A+'t')).strip()
                        if text:
                            blocks.append(f'[第{i}页幻灯片]\n{text}')
                        for target, relation in relationships(z, path).values():
                            if relation.endswith('/notesSlide') and target in z.namelist():
                                note_root = xml(z, target)
                                notes = []
                                for shape in note_root.iter(P+'sp'):
                                    if any(ph.attrib.get('type') in {'sldNum', 'hdr', 'ftr', 'dt'} for ph in shape.iter(P+'ph')):
                                        continue
                                    notes.extend(x.text or '' for x in shape.iter(A+'t'))
                                if notes:
                                    blocks.append(f'[第{i}页讲稿备注]\n' + '\n'.join(notes))
                        units += 1
                    kind = 'PPT'
                else:
                    shared = []
                    if 'xl/sharedStrings.xml' in z.namelist():
                        shared = [''.join(x.text or '' for x in si.iter(S+'t')) for si in xml(z, 'xl/sharedStrings.xml').iter(S+'si')]
                    workbook = xml(z, 'xl/workbook.xml')
                    rels = relationships(z, 'xl/workbook.xml')
                    for sheet in workbook.iter(S+'sheet'):
                        path = rels.get(sheet.attrib.get(R+'id'), ('', ''))[0]
                        if path not in z.namelist():
                            continue
                        rows = []
                        for row in xml(z, path).iter(S+'row'):
                            cells = []
                            for cell in row.iter(S+'c'):
                                v = cell.find(S+'v')
                                text = v.text if v is not None and v.text else ''
                                if cell.attrib.get('t') == 's':
                                    text = shared[int(text)] if text and int(text) < len(shared) else ''
                                elif cell.attrib.get('t') == 'inlineStr':
                                    text = ''.join(x.text or '' for x in cell.iter(S+'t'))
                                formula = cell.find(S+'f')
                                if formula is not None:
                                    text = '=' + (formula.text or '') + (' → '+text if text else '')
                                if text:
                                    cells.append(cell.attrib.get('r', '') + ': ' + text)
                            if cells:
                                rows.append(' | '.join(cells))
                        blocks.append('[工作表 ' + sheet.attrib.get('name', '') + ']\n' + '\n'.join(rows))
                        units += 1
                    kind = 'Excel'
        elif suffix == '.pdf':
            try:
                from pypdf import PdfReader
            except ImportError:
                raise ValueError('PDF 文字读取组件不可用，请改用 Word 或文本文件。') from None
            reader = PdfReader(io.BytesIO(content), strict=False)
            if reader.is_encrypted:
                raise ValueError('请先解除 PDF 密码，再上传。')
            if len(reader.pages) > 500:
                raise ValueError('PDF 超过 500 页，请分段上传。')
            for i, page in enumerate(reader.pages, 1):
                text = (page.extract_text() or '').strip()
                if text:
                    blocks.append(f'[第{i}页]\n{text}')
            units, kind = len(reader.pages), 'PDF'
            warning = '只读取可提取的文字，图片和扫描页未做识别。'
        else:
            decoded = None
            encodings = ['utf-16'] if content.startswith((b'\xff\xfe', b'\xfe\xff')) else ['utf-8-sig', 'gb18030']
            for encoding in encodings:
                try:
                    decoded = content.decode(encoding)
                    break
                except UnicodeDecodeError:
                    pass
            if decoded is None or '\x00' in decoded:
                raise ValueError('无法读取文本编码。')
            blocks = [decoded.strip()]
            units, kind = len(decoded.splitlines()), '文本'
    except ValueError:
        raise
    except Exception:
        raise ValueError('文件无法解析，请确认格式正确且未加密。') from None
    text = '\n\n'.join(blocks).strip()
    if not text:
        raise ValueError('没有提取到可读文字。请上传含正文文字的文件；图片和扫描件暂不做识别。')
    return {'text': text[:MAX_TEXT], 'kind': kind, 'units': units, 'characters': len(text),
            'truncated': len(text) > MAX_TEXT, 'warning': warning}
