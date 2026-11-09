#!/usr/bin/env python3
import json, os, pathlib, sys
home = pathlib.Path(os.environ['FM_HOME'])
path = home / 'notes.json'
notes = json.loads(path.read_text()) if path.exists() else []
if sys.argv[1] == 'note':
    request = sys.argv[sys.argv.index('--request-id') + 1]
    content = json.loads(sys.stdin.read().splitlines()[1])
    question = content['question']
    if question == 'Capture failure':
        sys.exit(1)
    note_id = 'published-' + content['request_id']
    body = 'Independent reply survives an unrelated malformed answer'
    if question == 'Malformed structured answer':
        body = json.dumps({'schema':'tinstar.ask-reply.v1','request_id':content['request_id'],
            'summary':'Preserved answer','detail':'Preserved evidence',
            'references':[{'label':'Evidence','url':'https://example.test'},{'label':'Unsafe','url':'javascript:alert(1)'}],
            'suggested_actions':[{'id':'unsafe','label':'Run code','instruction':'eval(source)'}]})
    reply = {'id':note_id,'at':'2026-11-09T16:31:00.000Z','body':body,'cursor':str(len(notes) + 1)}
    notes.append({'id':note_id,'request_id':request,'reply':reply})
    path.write_text(json.dumps(notes))
    print(json.dumps({'schema':'fm-inbox-note.v1','outcome':'created','id':note_id,'request_id':request,
        'saved':True,'announced':question != 'Wake failure','acknowledged':False}))
    sys.exit(3 if question == 'Wake failure' else 0)
elif sys.argv[1:] == ['receipts','--all-pending','--all-handled','--all-replies']:
    print(json.dumps({'schema':'fm-inbox-receipts.v1','pending':notes,'handled':[],'omitted':[]}))
else:
    sys.exit(1)
