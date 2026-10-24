"""Execute the repository's actual response producer with isolated DB/embedding.
No imports with service side effects, network, provider calls or production data.
This generated response is a contract fixture, not a captured Hosted response.
"""
import ast
import json
import math
from pathlib import Path
from types import SimpleNamespace as Row
from typing import Any

source = Path('integrations/singapore-kb/backend-r109027/app/services/vector_store.py')
names = {'_cosine', '_normalize_text', '_json_int', 'kb_context_search'}
nodes = [n for n in ast.parse(source.read_text()).body if isinstance(n, ast.FunctionDef) and n.name in names]
assert {n.name for n in nodes} == names
class Column:
    def __eq__(self, other): return True
    def in_(self, other): return True
    def isnot(self, other): return True
    def is_(self, other): return True
class Columns(type):
    def __getattr__(cls, name): return Column()
class Document(metaclass=Columns): pass
class Chunk(metaclass=Columns): pass
class Query:
    def __init__(self, rows): self.rows = rows
    def join(self, *args): return self
    def filter(self, *args): return self
    def all(self): return self.rows
summary_id, full_id = '1'*32, '2'*32
rows = [Row(id='a'*32, document_id=summary_id, embedding_vector=[1,0], chunk_index=0, chunk_type='rag_summary', chunk_text='General overview only'),
        Row(id='b'*32, document_id=full_id, embedding_vector=[0.8,0.6], chunk_index=0, chunk_type='full_content', chunk_text='Harbor Care includes inspection and collection.')]
docs = [Row(id=summary_id, status='published', name='', source_type=''), Row(id=full_id, status='published', name='Harbor Care', source_type='Other')]
class DB:
    def query(self, model): return Query(rows if model is Chunk else docs)
namespace = dict(Session=object, Any=Any, math=math, KBVectorChunk=Chunk, KBDocument=Document, embed_text=lambda text:([1,0],None,None))
exec(compile(ast.Module(body=nodes,type_ignores=[]),str(source),'exec'), namespace)
result = namespace['kb_context_search'](DB(),'What is Harbor Care?',company_id=34,max_documents=5,score_threshold=0.05)
assert result['context_found'] is True and result['selected_documents'][0]['evidence']==[]
assert result['selected_documents'][0]['summary']['chunk_type']=='rag_summary'
assert result['selected_documents'][1]['evidence'][0]['chunk_type']=='full_content'
print(json.dumps(result))
