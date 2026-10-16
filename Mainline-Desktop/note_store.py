"""Local writing drafts, revisions and image bytes, included in SQLite backups."""
from __future__ import annotations

import base64
import datetime as dt
import io
import json
import re
import uuid
import zipfile

MAX_NOTE_LENGTH = 300_000
MAX_IMAGE_BYTES = 8 * 1024 * 1024
IMAGE_REF = re.compile(r'(?:https?://(?:127\.0\.0\.1|localhost):\d+)?/note-assets/([a-f0-9]{32})')


def timestamp():
    return dt.datetime.now(dt.timezone(dt.timedelta(hours=8))).replace(tzinfo=None, microsecond=0).isoformat()


def image_type(raw):
    if not isinstance(raw, bytes) or not 0 < len(raw) <= MAX_IMAGE_BYTES:
        raise ValueError('请选择一张不超过 8 MB 的图片。')
    if raw.startswith(b'\x89PNG\r\n\x1a\n'):
        return 'image/png', '.png'
    if raw.startswith(b'\xff\xd8\xff'):
        return 'image/jpeg', '.jpg'
    if raw.startswith((b'GIF87a', b'GIF89a')):
        return 'image/gif', '.gif'
    if raw.startswith(b'RIFF') and raw[8:12] == b'WEBP':
        return 'image/webp', '.webp'
    raise ValueError('支持 PNG、JPEG、GIF 和 WebP 图片；请将其他格式另存为 PNG。')


class NotebookMixin:
    def init_notebook(self, db):
        db.executescript('''
        CREATE TABLE IF NOT EXISTS note_images(id TEXT PRIMARY KEY, metadata TEXT NOT NULL, body BLOB NOT NULL);
        CREATE TABLE IF NOT EXISTS note_drafts(id TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS note_versions(id TEXT PRIMARY KEY, note_id TEXT NOT NULL, data TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS note_versions_by_note ON note_versions(note_id);
        ''')

    def persist_note(self, record, old):
        """Checkpoint before edits, never rewriting an older snapshot."""
        changed = not old or any(record.get(k) != old.get(k) for k in ('title', 'content', 'project_id', 'format'))
        if not changed:
            return old
        record['revision'] = (old or {}).get('revision', 0) + 1
        with self.lock, self.connect() as db:
            if old:
                previous = db.execute('SELECT data FROM note_versions WHERE note_id=? ORDER BY rowid DESC LIMIT 1', (old['id'],)).fetchone()
                last = json.loads(previous[0]) if previous else None
                if (not last or record.pop('_checkpoint', False)
                        or (dt.datetime.fromisoformat(timestamp()) - dt.datetime.fromisoformat(last['saved_at'])).total_seconds() >= 300):
                    snapshot = {**old, 'saved_at': timestamp(), 'version_id': uuid.uuid4().hex}
                    db.execute('INSERT INTO note_versions VALUES(?,?,?)', (snapshot['version_id'], old['id'], json.dumps(snapshot, ensure_ascii=False)))
            record.pop('_checkpoint', None)
            db.execute('INSERT OR REPLACE INTO notes VALUES(?,?)', (record['id'], json.dumps(record, ensure_ascii=False)))
        return record

    def writing_drafts(self, summary=False):
        with self.lock, self.connect() as db:
            records = [json.loads(r[0]) for r in db.execute('SELECT data FROM note_drafts ORDER BY rowid DESC')]
        if summary:
            return [{k: d.get(k, '') for k in ('id', 'title', 'project_id', 'updated_at')} for d in records]
        return records

    def save_writing(self, data):
        item_id = data.get('id', '')
        if not isinstance(item_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', item_id):
            raise ValueError('笔记编号无效。')
        title, content = data.get('title', ''), data.get('content', '')
        if not isinstance(title, str) or len(title) > 160 or not isinstance(content, str) or len(content) > MAX_NOTE_LENGTH:
            raise ValueError('标题最多 160 字，正文最多 30 万字。')
        project_id = data.get('project_id', '')
        if not isinstance(project_id, str) or data.get('format', 'markdown') not in {'plain', 'markdown'}:
            raise ValueError('笔记格式或项目无效。')
        with self.lock:
            old = self.get('notes', item_id)
            draft = {k: data[k] for k in ('id', 'title', 'content', 'project_id', 'format', 'base_revision') if k in data}
            draft['updated_at'] = timestamp()
            # Even a conflict or incomplete note leaves a durable, recoverable draft.
            with self.connect() as db:
                db.execute('INSERT OR REPLACE INTO note_drafts VALUES(?,?)', (item_id, json.dumps(draft, ensure_ascii=False)))
            if old and not old.get('deleted_at') and all(
                    data.get(k, '') == old.get(k, '') for k in ('title', 'content', 'project_id', 'format')):
                with self.connect() as db:
                    db.execute('DELETE FROM note_drafts WHERE id=?', (item_id,))
                return {'saved': True, 'note': old}
            if (old and old.get('deleted_at')) or data.get('base_revision', 0) != (old or {}).get('revision', 0):
                return {'saved': False, 'conflict': True, 'draft_saved': True}
            if not title.strip() or not content.strip():
                return {'saved': False, 'draft_saved': True}
            record = self.note({**data, '_new_id': item_id}, item_id if old else None)
            with self.connect() as db:
                db.execute('DELETE FROM note_drafts WHERE id=?', (item_id,))
            return {'saved': True, 'note': record}

    def writing_versions(self, note_id):
        with self.lock, self.connect() as db:
            return [json.loads(r[0]) for r in db.execute('SELECT data FROM note_versions WHERE note_id=? ORDER BY rowid DESC LIMIT 30', (note_id,))]

    def add_note_image(self, filename, raw):
        mime, suffix = image_type(raw)
        image_id = uuid.uuid4().hex
        name = str(filename).replace('\\', '/').rsplit('/', 1)[-1][:160]
        metadata = {'id': image_id, 'name': name, 'mime': mime, 'suffix': suffix, 'size': len(raw), 'created_at': timestamp()}
        with self.lock, self.connect() as db:
            db.execute('INSERT INTO note_images VALUES(?,?,?)', (image_id, json.dumps(metadata, ensure_ascii=False), raw))
        return {**metadata, 'url': '/note-assets/' + image_id}

    def note_image(self, image_id):
        with self.lock, self.connect() as db:
            row = db.execute('SELECT metadata,body FROM note_images WHERE id=?', (image_id,)).fetchone()
        return (json.loads(row[0]), row[1]) if row else None

    def writing_export(self):
        with self.lock, self.connect() as db:
            images = [{**json.loads(r[0]), 'base64': base64.b64encode(r[1]).decode('ascii')}
                      for r in db.execute('SELECT metadata,body FROM note_images')]
            versions = [json.loads(r[0]) for r in db.execute('SELECT data FROM note_versions')]
        return {'images': images, 'drafts': self.writing_drafts(), 'versions': versions}

    def validate_writing_backup(self, payload):
        if not isinstance(payload, dict):
            raise ValueError('写作备份格式无效。')
        result = {'images': [], 'drafts': [], 'versions': []}
        for key in result:
            if not isinstance(payload.get(key, []), list) or len(payload.get(key, [])) > 100000:
                raise ValueError('写作备份记录无效。')
        for image in payload.get('images', []):
            if not isinstance(image, dict) or not re.fullmatch(r'[a-f0-9]{32}', str(image.get('id', ''))):
                raise ValueError('图片编号无效。')
            try:
                raw = base64.b64decode(image.get('base64', ''), validate=True)
            except (ValueError, TypeError):
                raise ValueError('图片备份内容无效。') from None
            mime, suffix = image_type(raw)
            meta = {k: v for k, v in image.items() if k != 'base64'}
            meta.update(mime=mime, suffix=suffix, size=len(raw))
            result['images'].append((image['id'], json.dumps(meta, ensure_ascii=False), raw))
        for key in ('drafts', 'versions'):
            for record in payload.get(key, []):
                if (not isinstance(record, dict) or not isinstance(record.get('content'), str)
                        or len(record['content']) > MAX_NOTE_LENGTH or not isinstance(record.get('title'), str)
                        or len(record['title']) > 160):
                    raise ValueError('写作草稿或版本内容无效。')
                required = ('id',) if key == 'drafts' else ('id', 'version_id')
                if any(not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', str(record.get(k, ''))) for k in required):
                    raise ValueError('写作记录编号无效。')
                result[key].append(record)
        return result

    def import_writing(self, db, payload):
        # Merge to preserve drafts and image references when restoring an older export.
        db.executemany('INSERT OR IGNORE INTO note_images VALUES(?,?,?)', payload['images'])
        db.executemany('INSERT OR IGNORE INTO note_drafts VALUES(?,?)', [(r['id'], json.dumps(r, ensure_ascii=False)) for r in payload['drafts']])
        db.executemany('INSERT OR IGNORE INTO note_versions VALUES(?,?,?)', [(r['version_id'], r['id'], json.dumps(r, ensure_ascii=False)) for r in payload['versions']])

    def export_note(self, note_id):
        note = self.get('notes', note_id)
        if not note:
            raise ValueError('请先保存笔记再导出。')
        content, images = note['content'], {}
        for image_id in set(IMAGE_REF.findall(content)):
            image = self.note_image(image_id)
            if not image:
                raise ValueError('有图片无法读取，导出已停止，以免遗漏。')
            meta, raw = image
            images[image_id] = ('images/' + image_id + meta['suffix'], raw)
        content = IMAGE_REF.sub(lambda m: images[m[1]][0], content)
        title = re.sub(r'[\x00-\x1f<>:"/\\|?*]', '_', note['title']).strip('. ')[:100] or '笔记'
        markdown = '# ' + note['title'] + '\n\n' + content
        if not images:
            return markdown.encode('utf-8'), title + '.md', 'text/markdown; charset=utf-8'
        output = io.BytesIO()
        with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as archive:
            archive.writestr(title + '.md', markdown)
            for path, raw in images.values():
                archive.writestr(path, raw)
        return output.getvalue(), title + '.zip', 'application/zip'
